#!/usr/bin/env ts-node
/**
 * DoctorateTs 管理命令行工具
 *
 * 用法：
 *   pnpm run admin -- <command> [options]    单命令执行
 *   pnpm run admin                           进入交互模式（REPL）
 *
 * 命令：
 * 用户:
 *   users list [--json] [--csv]                         列出所有用户
 *   users info <uid> [--json]                           查看用户详情
 *   users create <phone> [password]                     创建新用户
 *   users grant <uid> <itemId|名称> <count>             发放物品/资源（支持中文名/别名，如 "合成玉"）
 *   users grantchar <uid> <charId|干员名>               发放干员（重复按稀有度折算信物）
 *   users skin <uid> <skinId>                           解锁皮肤
 *   users chars <uid> [--json]                          干员列表
 *   users char <uid> <instId> [--level N] [--evolve N] [--potential N] [--skill N]   修改干员属性
 *   users maxout <uid>                                  一键满配（资源/背包/干员/基建/皮肤，不覆盖阵容）
 *   users building <uid> max                            基建满级
 *   users building <uid> advance <seconds>              基建加速（快进秒数并结算产出）
 *   users backup <uid>                                  备份存档
 *   users backups <uid> [--json]                        列出备份
 *   users restore <uid> <backupName>                    从备份恢复
 *   users dump <uid> [--pretty]                         导出原始玩家数据 JSON
 *
 * 邮件:
 *   mail send <uid[,uid...]|all> <subject> [content] [--items id:count,...]  发送邮件
  mail send <uid|all> --template <名称>                模板发送（补偿/公告/欢迎）
  mail templates [--json]                             查看邮件模板
 *   mail list <uid> [--json]                           查看用户邮件
 *   mail delete <uid> <mailId>                         删除单封邮件
 *
 * 服务器:
 *   server status                                      查看服务器状态
 *   server refresh <uid>                               触发每日/每周刷新（理智/任务重置）
 *   server save [uid]                                  立即保存存档（缺省保存全部用户）
 *
 * 配置:
 *   config show                                        查看当前配置
 *   config set <key> <value>                           修改配置（如 PORT 8443、offline false、admin.token xxx）
 *
 * 日志:
 *   logs show|audit [--last N] [--action x] [--uid x] [--json]    查看管理操作审计日志
 *   logs server [--date YYYYMMDD] [--level x] [--tag x] [--last N] [--json]  查看服务器日志
 *   logs watchdog [--json]                                     查看看门狗日志
 *
 * 抓包管理:
 *   capture sessions [--json]                                  抓包会话列表
 *   capture start <名称> [--source x]                          新建抓包会话
 *   capture stop <会话id>                                      停止抓包会话
 *   capture records [--path x] [--status n] [--source x] [--limit n] [--json]  抓包记录列表
 *   capture show <记录id|rid> [--json]                         查看单条记录（请求/响应）
 *   capture stats [--json] / capture export <会话id> / capture clear --yes
 *
 * 卡池管理:
 *   gacha pools [--json]                               列出全部卡池
 *   gacha pool <poolId> [--json]                       卡池详情（UP/可用干员+概率）
 *   gacha state <uid> <poolId> [--json]                玩家卡池状态（UP 选择+保底计数）
 *   gacha up <uid> <poolId> [charId...]                设置玩家 UP（空=清除）
 *   gacha pity <uid> [ruleType] [count]                查看/设置玩家保底计数
 *
 * 官服迁移:
 *   official accounts <file> [--json]                  预览账号文件解析结果
 *   official migrate <file> [--template uid]           官服账号迁移（联网拉取→注册私服账号）
 *
 * 其他:
 *   help / exit                                        帮助 / 退出交互模式
 *   全局 --quiet / -q：抑制内部 INFO 日志（便于脚本化）
 *
 * 说明：CLI 直接操作本地数据，无需启动服务器，完全离线可用。
 */
import * as readline from "readline";
import { readFileSync } from "fs";
import excel from "@excel/excel";
import { isJsonObject } from "@excel/json-value";
import type { JsonObject, JsonValue } from "@excel/json-value";
import { isOfficialAction } from "@ops/admin/official-ops";
import type { OfficialAction } from "@ops/admin/official-ops";
import { accountManager } from "@game/modules/account/account-manager";
import { adminService } from "@ops/admin/admin-service";
import config from "@core/config/index";
import { captureManager } from "@capture/capture-manager";
import { logService } from "@logs/log-service";
import { writeJson, readJsonSync } from "@utils/file";

/** 解析结果 */
export interface ParsedArgs {
  command: string;
  args: string[];
  flags: { [key: string]: string };
}

/** 解析命令行参数：<command> [args...] [--key value] */
export function parseArgs(argv: string[]): ParsedArgs {
  const args: string[] = [];
  const flags: { [key: string]: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      flags[key] = argv[i + 1] ?? "true";
      i++;
    } else {
      args.push(a);
    }
  }
  return { command: args[0] ?? "", args: args.slice(1), flags };
}

/** 初始化游戏数据（excel + 账户），CLI 每次运行前调用 */
export async function cliInit(): Promise<void> {
  await excel.init();
  await accountManager.init();
}

/**
 * 输出：--json 时输出 JSON；否则表格/对象
 * @param data - 待输出数据（数组时可按行映射为表格列）
 * @param flags - CLI 标志（`json` 走原样 JSON 输出）
 * @param table - 表格行映射（仅数组数据生效）；行类型随 `data` 元素类型推导
 */
function output<T>(
  data: T[] | T,
  flags: { [key: string]: string },
  table?: (row: T) => Record<string, string | number>,
): void {
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (Array.isArray(data) && table) {
    console.table(data.map(table));
    return;
  }
  if (typeof data === "object" && data !== null) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(data);
  }
}

/** 打印帮助 */
export function printHelp(): void {
  console.log(`DoctorateTs 管理命令行工具
用法: pnpm run admin -- <command> [options]     （无参数进入交互模式）

活动切换（自定义：时间冻结 + 强制开启 + 合约赛季 + 资产补全）:
  activities list [--json]                                   列出活动与开关状态
  activities switch <timestamp|-1> [--force id1,id2] [--crisisV1 ccN] [--crisisV2 ccN]   切换活动（-1 恢复真实时间；--force 逗号分隔活动id）
  activities crisis [--v1 ccN] [--v2 ccN]                    仅切换危机合约赛季（V1: data/crisis/*.json，V2: data/crisisV2/*.json）
  activities force [--ids id1,id2]                           仅设置强制开启活动列表（空=清空）
  activities backfill <all|活动id|危机赛季id> [--platform x]  启动资产补全后台任务（补全过往活动缺失 asset）
  activities backfill-status <任务id> [--json]               查询补全任务进度

用户管理:
  users list [--json] [--csv] [--filter 关键字]     列出所有用户（可过滤）
  users info <uid> [--json]                         查看用户详情
  users create <phone> [password]                   创建新用户
  users grant <uid[,uid...]> <itemId|名称> <count>  发放物品（uid 支持逗号分隔批量）
  users grantchar <uid> <charId|干员名>             发放干员
  users skin <uid> <skinId>                         解锁皮肤
  users chars <uid> [--json]                        干员列表
  users char <uid> <instId> [--level N] [--evolve N] [--potential N] [--skill N]  修改干员属性
  users maxout <uid>                                一键满配（不覆盖阵容）
  users building <uid> max                          基建满级
  users building <uid> advance <seconds>            基建加速（快进秒数并结算产出）
  users backup <uid> / users backups <uid> / users restore <uid> <备份名>   备份/列出/恢复
  users dump <uid> [--pretty]                       导出原始玩家数据 JSON
  users grantall <uid> [count]                      批量发放全部物品（默认 999）
  users maxchars <uid>                              批量拉满全部已有干员
  users repairchars <uid>                           修复干员结构（补齐缺失字段）
  users stages <uid> [--json]                       查看玩家推图进度（只读）
  users unlock <uid> <stageId>                      解锁指定关卡
  users unlockall <uid>                             推图全解锁
  users items <关键字> [limit] [--json]             按名称/ID 搜索物品（供发放用）
  users missions <uid> [--json]                     查看任务进度统计（只读）
  users medals <uid> [--json]                       查看勋章进度（只读）
  users activity <uid> [--json]                     查看活动数据摘要（只读）
  users shop <uid> [--json]                         查看商店数据汇总（只读）
  users shop <uid> refresh                         手动刷新信用交易所（重置当日购买记录）
  users checkin <uid> [--reset|--do]                查看/重置/代签签到
  users daily <uid>                               一键日常（每日刷新+代签）
  users export <uid> [path]                         导出存档到 JSON（默认 ./exports/）
  users import <存档JSON> [uid]                     从 JSON 导入/替换存档
  users delete <uid> --yes                          删除用户（危险操作，需 --yes）
  users grantall <uid> [count]                      批量发放全部物品（默认 999）
  users maxchars <uid>                              批量拉满全部已有干员
  users repairchars <uid>                           修复干员结构（补齐缺失字段）
  users stages <uid> [--json]                       查看玩家推图进度（只读）
  users unlock <uid> <stageId>                      解锁指定关卡
  users unlockall <uid>                             推图全解锁
  users items <关键字> [limit] [--json]             按名称/ID 搜索物品（供发放用）
  users missions <uid> [--json]                     查看任务进度统计（只读）
  users medals <uid> [--json]                       查看勋章进度（只读）
  users activity <uid> [--json]                     查看活动数据摘要（只读）
  users shop <uid> [--json]                         查看商店数据汇总（只读）
  users shop <uid> refresh                         手动刷新信用交易所（重置当日购买记录）
  users checkin <uid> [--reset|--do]                查看/重置/代签签到
  users daily <uid>                               一键日常（每日刷新+代签）
  users export <uid> [path]                         导出存档到 JSON（默认 ./exports/）
  users import <存档JSON> [uid]                     从 JSON 导入/替换存档
  users delete <uid> --yes                          删除用户（危险操作，需 --yes）

邮件:
  mail send <uid[,uid...]|all> <subject> [content] [--items id:count,...]  发送邮件
  mail send <uid|all> --template <名称>                模板发送（补偿/公告/欢迎）
  mail templates [--json]                             查看邮件模板
  mail list <uid> [--json]                          查看用户邮件
  mail delete <uid> <mailId>                        删除单封邮件

服务器:
  server status                                     查看服务器状态
  server refresh <uid>                              触发每日/每周刷新
  server save [uid]                                 立即保存存档（缺省全部用户）
  server check [--files]                              数据校验（--files 校验磁盘全部存档）（status/troop/可序列化）

配置:
  config show / config set <key> <value>

日志:
  logs show|audit [--last N] [--action x] [--uid x] [--json]   查看审计日志
  logs server [--date YYYYMMDD] [--level x] [--tag x] [--last N] [--json]  查看服务器日志
  logs watchdog [--json]                                    查看看门狗日志
  logs clear --yes                                          清空审计日志（危险操作）
  logs server-clear --yes                                   清空服务器日志（危险操作）

抓包管理:
  capture sessions [--json]                                  抓包会话列表
  capture start <名称> [--source x]                          新建抓包会话
  capture stop <会话id>                                      停止抓包会话
  capture records [--path x] [--status n] [--source x] [--session id] [--limit n] [--json]  抓包记录列表
  capture show <记录id|rid> [--json]                         查看单条记录（请求/响应）
  capture stats [--json]                                     抓包统计
  capture export <会话id>                                    导出会话 zip
  capture clear --yes                                        清空全部抓包（危险操作）

卡池管理:
  gacha pools [--json]                              列出全部卡池
  gacha pool <poolId> [--json]                      卡池详情（UP/可用干员+概率）
  gacha state <uid> <poolId> [--json]               玩家卡池状态（UP 选择+保底计数）
  gacha up <uid> <poolId> [charId...]               设置玩家 UP（空=清除）
  gacha pity <uid> [ruleType] [count]               查看/设置玩家保底计数

支付管理:
  pay orders [uid] [--json]                         支付订单列表（状态机 created/paid/delivered）
  pay order confirm <orderId>                       手动确认支付（real 模式真实收款后标记 paid）

官服迁移:
  official accounts <file> [--json]                 预览账号文件解析结果
  official migrate <file> [--template uid]          官服账号迁移（联网拉取→注册私服账号）
  official <status|signin|mails|receive|daily> <phone> <pwd>   官服操作（登录官服签到/邮件等）
  official call <phone> <pwd> <cgi> [--body json]              官服通用 API 调用（登录后任意 cgi）
  official gacha-sync <phone> <pwd> [--pools a,b] [--refresh]  从官服同步卡池详情（补全模式跳过已有，--refresh 全量）

其他:
  tools <name> [args...]                             开发工具统一入口（validate-*/dump-*/parse-arkhub 等，tools help 查看）
  help / exit                                       帮助 / 退出`);
}

/** users 子命令 */
async function runUsers(args: string[], flags: { [key: string]: string }): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case "list": {
      const filter = flags.filter ?? "";
      const users = await adminService.listUsers(filter);
      if (flags.csv) {
        console.log("uid,nickName,level,phone,lastOnlineTs");
        for (const u of users) {
          console.log(
            [u.uid, u.nickName, u.level, u.phone, u.lastOnlineTs].join(","),
          );
        }
        return;
      }
      output(
        users,
        flags,
        (u) => ({
          uid: u.uid,
          昵称: u.nickName,
          等级: u.level,
          手机: u.phone,
          最后在线: u.lastOnlineTs ? new Date(u.lastOnlineTs * 1000).toLocaleDateString() : "-",
        }),
      );
      return;
    }
    case "info": {
      const uid = args[1];
      if (!uid) {
        console.error("用法: users info <uid>");
        process.exitCode = 1;
        return;
      }
      const info = await adminService.getUserInfo(uid);
      if (!info) {
        console.error(`用户不存在: ${uid}`);
        process.exitCode = 1;
        return;
      }
      if (flags.json) {
        output(info, flags);
        return;
      }
      console.log(`用户 ${uid}（${info.nickName}#${info.nickNumber}） Lv.${info.level}`);
      console.log(`  龙门币 ${info.gold} | 合成玉 ${info.androidDiamond} | 寻访凭证 ${info.gachaTicket}`);
      console.log(`  理智 ${info.ap}/${info.maxAp ?? "-"} | 招募许可 ${info.recruitLicense} | 演习券 ${info.practiceTicket}`);
      console.log(`  高级凭证 ${info.hggShard ?? 0} | 资质凭证 ${info.lggShard ?? 0} | 社交点 ${info.socialPoint ?? 0} | 加急许可 ${info.instantFinishTicket ?? 0}`);
      console.log(`  干员数 ${info.charCnt} | 注册时间 ${new Date(info.registerTs * 1000).toLocaleString()}`);
      const top = info.inventoryInfo.slice(0, 15);
      if (top.length) {
        console.log("  背包（前 15）:");
        for (const it of top) {
          console.log(`    ${it.name}(${it.id}) x${it.count}`);
        }
      }
      return;
    }
    case "create": {
      const phone = args[1];
      const password = args[2] ?? phone;
      if (!phone) {
        console.error("用法: users create <phone> [password]");
        process.exitCode = 1;
        return;
      }
      const uid = await adminService.createUser(phone, password);
      console.log(`已创建用户 uid=${uid}（手机 ${phone}）`);
      return;
    }
    case "grant": {
      const uidArg = args[1];
      const uids = String(uidArg ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!uids.length) {
        console.error("用法: users grant <uid[,uid...]> <itemId|名称> <count> | users grant <uid[,uid...]> --items id:count,id:count");
        process.exitCode = 1;
        return;
      }
      // 多物品批量：--items id:count,id:count
      if (flags.items && flags.items !== "true") {
        const items = flags.items.split(",").map((pair: string) => {
          const [id, cnt] = pair.split(":");
          return { id, count: Number(cnt ?? 1) };
        }).filter((it) => it.id && Number.isInteger(it.count) && it.count > 0);
        if (!items.length) {
          console.error("--items 格式: id:count,id:count（count 为正整数）");
          process.exitCode = 1;
          return;
        }
        for (const uid of uids) {
          for (const it of items) {
            await adminService.grantItem(uid, it.id, it.count);
          }
          console.log(`已向用户 ${uid} 批量发放 ${items.length} 种物品`);
        }
        return;
      }
      const itemId = args[2];
      const countStr = args[3];
      const count = Number(countStr);
      if (!itemId || !countStr || !Number.isInteger(count) || count <= 0) {
        console.error("用法: users grant <uid[,uid...]> <itemId|名称> <count>（count 为正整数；uid 支持逗号分隔批量）");
        process.exitCode = 1;
        return;
      }
      for (const uid of uids) {
        await adminService.grantItem(uid, itemId, count);
        console.log(`已向用户 ${uid} 发放 ${itemId} x${count}`);
      }
      return;
    }
    case "grantchar": {
      const uid = args[1];
      const charId = args[2];
      if (!uid || !charId) {
        console.error("用法: users grantchar <uid> <charId|干员名>");
        process.exitCode = 1;
        return;
      }
      const res = await adminService.grantChar(uid, charId);
      console.log(`已向用户 ${uid} 发放干员 ${res.name}（${res.isNew ? "新干员" : "重复"}）`);
      return;
    }
    case "skin": {
      const uid = args[1];
      const skinId = args[2];
      if (!uid || !skinId) {
        console.error("用法: users skin <uid> <skinId>");
        process.exitCode = 1;
        return;
      }
      await adminService.grantSkin(uid, skinId);
      console.log(`已向用户 ${uid} 解锁皮肤 ${skinId}`);
      return;
    }
    case "chars": {
      const uid = args[1];
      if (!uid) {
        console.error("用法: users chars <uid> [--json]");
        process.exitCode = 1;
        return;
      }
      const chars = await adminService.listChars(uid);
      output(
        chars,
        flags,
        (c) => ({
          instId: c.instId,
          干员: `${c.name}(${c.charId})`,
          星级: c.rarity + 1,
          等级: `${c.level}/${c.maxLevel}`,
          精二: c.evolvePhase,
          潜能: c.potentialRank,
          技能: c.mainSkillLvl,
        }),
      );
      return;
    }
    case "char": {
      const uid = args[1];
      const instId = Number(args[2]);
      if (!uid || !Number.isInteger(instId)) {
        console.error("用法: users char <uid> <instId> [--level N] [--evolve N] [--potential N] [--skill N]");
        process.exitCode = 1;
        return;
      }
      const attrs: { [key: string]: number } = {};
      for (const key of ["level", "evolve", "potential", "skill"] as const) {
        if (flags[key] !== undefined && flags[key] !== "true") {
          const n = Number(flags[key]);
          if (!Number.isInteger(n)) {
            console.error(`参数 --${key} 必须是整数`);
            process.exitCode = 1;
            return;
          }
          attrs[key === "evolve" ? "evolvePhase" : key === "potential" ? "potentialRank" : key === "skill" ? "mainSkillLvl" : key] = n;
        }
      }
      // 无编辑参数 → 显示干员详情
      if (Object.keys(attrs).length === 0) {
        const d = await adminService.getCharDetail(uid, instId);
        if (!d) {
          console.error(`干员不存在: instId=${instId}`);
          process.exitCode = 1;
          return;
        }
        if (flags.json) {
          output(d, flags);
          return;
        }
        console.log(`${d.name}(${d.charId}) ${d.rarity + 1}★ instId=${d.instId}`);
        console.log(`  等级 ${d.level}/${d.maxLevel} | 精二 ${d.evolvePhase} | 潜能 ${d.potentialRank} | 技能 ${d.mainSkillLvl} | 信赖 ${d.favorPoint}`);
        console.log(`  语音 ${d.voiceLan} | 皮肤 ${d.skin ? `${d.skinName ?? d.skin}(${d.skin})` : "默认"}`);
        console.log(`  当前装备 ${d.currentEquip ?? "无"}`);
        if (d.skills.length) {
          console.log("  技能:");
          for (const s of d.skills) {
            console.log(`    ${s.skillId} [${s.unlock ? "解锁" : "未解锁"}] 专精 ${s.specializeLevel}`);
          }
        }
        return;
      }
      const result = await adminService.setCharAttrs(uid, instId, attrs);
      console.log(
        `已修改 ${result.name}(instId=${instId})：精二 ${result.evolvePhase} | 等级 ${result.level} | 潜能 ${result.potentialRank} | 技能 ${result.mainSkillLvl}`,
      );
      return;
    }
    case "maxout": {
      const uid = args[1];
      if (!uid) {
        console.error("用法: users maxout <uid>");
        process.exitCode = 1;
        return;
      }
      const stats = await adminService.maxOutAccount(uid);
      console.log(
        `已满配用户 ${uid}：干员 ${stats.chars} | 物品 ${stats.items} | 皮肤 ${stats.skins} | 基建 ${stats.rooms}`,
      );
      return;
    }
    case "building": {
      const uid = args[1];
      const act = args[2];
      if (!uid || (act !== "max" && act !== "advance")) {
        console.error("用法: users building <uid> max | users building <uid> advance <seconds>");
        process.exitCode = 1;
        return;
      }
      if (act === "max") {
        const result = await adminService.buildingMax(uid);
        console.log(`已满级基建 ${result.rooms} 间房间`);
        return;
      }
      const secs = Number(args[3]);
      if (!Number.isInteger(secs) || secs <= 0) {
        console.error("用法: users building <uid> advance <seconds>（秒数须为正整数）");
        process.exitCode = 1;
        return;
      }
      const result = await adminService.buildingAdvance(uid, secs);
      console.log(`已快进基建 ${result.advanced} 秒并结算产出`);
      return;
    }
    case "backup": {
      const uid = args[1];
      if (!uid) {
        console.error("用法: users backup <uid>");
        process.exitCode = 1;
        return;
      }
      const info = await adminService.backup(uid);
      console.log(`已备份 ${info.name}（${(info.size / 1024).toFixed(1)}KB）`);
      return;
    }
    case "backups": {
      const uid = args[1];
      const sub = args[2];
      if (!uid) {
        console.error("用法: users backups <uid> [--json] | users backups <uid> clean [--keep N]");
        process.exitCode = 1;
        return;
      }
      if (sub === "clean") {
        const keep = Number(args[3] ?? flags.keep ?? 10);
        if (!Number.isInteger(keep) || keep < 0) {
          console.error("keep 必须为非负整数（保留最近 N 个）");
          process.exitCode = 1;
          return;
        }
        const r = await adminService.cleanBackups(uid, keep);
        console.log(`已清理用户 ${uid} 的 ${r.removed} 个旧备份（保留 ${r.kept} 个）`);
        return;
      }
      const list = await adminService.listBackups(uid);
      if (flags.json) {
        output(list, flags);
        return;
      }
      if (!list.length) {
        console.log(`用户 ${uid} 暂无备份`);
        return;
      }
      console.table(
        list.map((b) => ({
          文件: b.name,
          大小: `${(b.size / 1024).toFixed(1)}KB`,
          时间: new Date(b.ts * 1000).toLocaleString(),
        })),
      );
      return;
    }
    case "restore": {
      const uid = args[1];
      const backup = args[2];
      if (!uid || !backup) {
        console.error("用法: users restore <uid> <backupName>");
        process.exitCode = 1;
        return;
      }
      await adminService.restore(uid, backup);
      console.log(`已从 ${backup} 恢复用户 ${uid}`);
      return;
    }
    case "dump": {
      const uid = args[1];
      if (!uid) {
        console.error("用法: users dump <uid> [--pretty]");
        process.exitCode = 1;
        return;
      }
      const data = await adminService.getRawJson(uid);
      console.log(
        JSON.stringify(data, null, flags.pretty === "true" || flags.pretty ? 2 : 0),
      );
      return;
    }
    case "delete": {
      const uid = args[1];
      if (!uid) {
        console.error("用法: users delete <uid>（不可恢复——先 users backup）");
        process.exitCode = 1;
        return;
      }
      // CLI 输入即意图，传入确认词通过 AdminService 的防误删守卫
      await adminService.deleteUser(uid, "DELETE");
      console.log(`已删除用户 ${uid}（configs/存档/SQLite 社交与战斗数据）`);
      return;
    }
    case "grantall": {
      const uid = args[1];
      const count = Number(args[2] ?? 999);
      if (!uid || !Number.isInteger(count) || count <= 0) {
        console.error("用法: users grantall <uid> [count]（count 为正整数，默认 999）");
        process.exitCode = 1;
        return;
      }
      const result = await adminService.grantAllItems(uid, count);
      console.log(`已向用户 ${uid} 批量发放 ${result.items} 种物品 x${count}`);
      return;
    }
    case "maxchars": {
      const uid = args[1];
      if (!uid) {
        console.error("用法: users maxchars <uid>");
        process.exitCode = 1;
        return;
      }
      const result = await adminService.maxAllChars(uid);
      console.log(`已拉满用户 ${uid} 的 ${result.chars} 名干员`);
      return;
    }
    case "repairchars": {
      const uid = args[1];
      if (!uid) {
        console.error("用法: users repairchars <uid>");
        process.exitCode = 1;
        return;
      }
      const result = await adminService.repairChars(uid);
      console.log(`已修复用户 ${uid} 干员结构：${result.chars} 名干员 / ${result.fields} 个字段`);
      return;
    }
    case "stages": {
      const uid = args[1];
      if (!uid) {
        console.error("用法: users stages <uid> [--json]");
        process.exitCode = 1;
        return;
      }
      const st = await adminService.listStages(uid);
      if (flags.json) {
        output(st, flags);
        return;
      }
      console.log(`用户 ${uid} 推图进度：已解锁 ${st.total} 关 | 已完成 ${st.done} 关`);
      const top = st.stages.slice(0, 30);
      if (top.length) {
        console.table(
          top.map((s) => ({
            关卡: s.stageId,
            状态: s.state,
            完成次数: s.completeTimes,
          })),
        );
      }
      return;
    }
    case "unlock": {
      const uid = args[1];
      const stageId = args[2];
      if (!uid || !stageId) {
        console.error("用法: users unlock <uid> <stageId>");
        process.exitCode = 1;
        return;
      }
      const r = await adminService.unlockStage(uid, stageId);
      console.log(`已解锁用户 ${uid} 的关卡 ${r.stageId}`);
      return;
    }
    case "unlockall": {
      const uid = args[1];
      if (!uid) {
        console.error("用法: users unlockall <uid>");
        process.exitCode = 1;
        return;
      }
      const r = await adminService.unlockAllStages(uid);
      console.log(`已推图全解锁用户 ${uid}：新增 ${r.stages} 关（共 ${r.total} 关）`);
      return;
    }
    case "items": {
      const q = args[1] ?? "";
      const limit = Number(args[2] ?? flags.limit ?? 50);
      const list = adminService.searchItems(q, Number.isFinite(limit) ? limit : 50);
      if (flags.json) {
        output(list, flags);
        return;
      }
      if (!list.length) {
        console.log(`未找到匹配物品: ${q || "(空)"}`);
        return;
      }
      console.table(
        list.map((it) => ({ ID: it.id, 名称: it.name, 类型: it.classifyType })),
      );
      return;
    }
    case "missions": {
      const uid = args[1];
      if (!uid) {
        console.error("用法: users missions <uid> [--json]");
        process.exitCode = 1;
        return;
      }
      const st = await adminService.listMissionStats(uid);
      if (flags.json) {
        output(st, flags);
        return;
      }
      console.log(`用户 ${uid} 任务进度：已完成 ${st.done}/${st.total}`);
      if (st.groups.length) {
        console.table(
          st.groups.map((g) => ({ 任务组: g.group, 完成: g.done, 总数: g.total })),
        );
      }
      return;
    }
    case "medals": {
      const uid = args[1];
      if (!uid) {
        console.error("用法: users medals <uid> [--json]");
        process.exitCode = 1;
        return;
      }
      const st = await adminService.listMedals(uid);
      if (flags.json) {
        output(st, flags);
        return;
      }
      console.log(`用户 ${uid} 勋章进度：已解锁 ${st.unlocked}/${st.total}`);
      return;
    }
    case "activity": {
      const uid = args[1];
      if (!uid) {
        console.error("用法: users activity <uid> [--json]");
        process.exitCode = 1;
        return;
      }
      const st = await adminService.getActivitySummary(uid);
      if (flags.json) {
        output(st, flags);
        return;
      }
      console.log(`用户 ${uid} 活动数据：共 ${st.total} 个活动`);
      if (st.types.length) {
        console.table(
          st.types.map((t) => ({ 类型: t.type, 活动数: t.activities })),
        );
      }
      return;
    }
    case "export": {
      const uid = args[1];
      const target = args[2];
      if (!uid) {
        console.error("用法: users export <uid> [path]（缺省 ./exports/{uid}-{ts}.json）");
        process.exitCode = 1;
        return;
      }
      const r = await adminService.exportUser(uid, target);
      console.log(`已导出用户 ${uid} 存档 → ${r.path}（${(r.size / 1024).toFixed(1)}KB）`);
      return;
    }
    case "import": {
      const file = args[1];
      const uid = args[2];
      if (!file) {
        console.error("用法: users import <存档JSON> [uid]（uid 缺省取文件内 status.uid）");
        process.exitCode = 1;
        return;
      }
      const r = await adminService.importUser(file, uid);
      console.log(`已导入存档到用户 ${r.uid}`);
      return;
    }
    case "delete": {
      const uid = args[1];
      if (!uid) {
        console.error("用法: users delete <uid> --yes（危险操作，删除存档与账号）");
        process.exitCode = 1;
        return;
      }
      if (flags.yes !== "true") {
        console.error("危险操作：确认删除请加 --yes");
        process.exitCode = 1;
        return;
      }
      const r = await adminService.deleteUser(uid, "DELETE");
      console.log(`已删除用户 ${r.uid}`);
      return;
    }
    case "shop": {
      const uid = args[1];
      if (!uid) {
        console.error("用法: users shop <uid> [--json] | users shop <uid> refresh");
        process.exitCode = 1;
        return;
      }
      // 服务器指令：手动刷新信用交易所（重置当日购买记录 + 更新信用商店 shopId）
      if (args[2] === "refresh") {
        await adminService.refreshSocialShop(uid);
        console.log(`用户 ${uid} 信用交易所已手动刷新（等价每日 04:00 自动刷新）`);
        return;
      }
      const st = await adminService.getShopSummary(uid);
      if (flags.json) {
        output(st, flags);
        return;
      }
      console.log(`用户 ${uid} 商店数据：共 ${st.total} 条购买记录`);
      if (st.types.length) {
        console.table(
          st.types.map((t) => ({ 类型: t.type, 当前商店: t.curShopId ?? "-", 记录数: t.items })),
        );
      }
      return;
    }
    case "checkin": {
      const uid = args[1];
      if (!uid) {
        console.error("用法: users checkin <uid> [--reset|--do] [--json]");
        process.exitCode = 1;
        return;
      }
      if (flags.reset === "true") {
        const st = await adminService.resetCheckIn(uid);
        console.log(`已重置用户 ${uid} 签到（组 ${st.groupTitle}，档位 ${st.rewardIndex + 1}/${st.total}）`);
        return;
      }
      if (flags.do === "true") {
        const r = await adminService.doCheckIn(uid);
        console.log(
          r.rewards.length
            ? `已代签用户 ${uid}：${r.rewards.map((x) => `${x.name}x${x.count}`).join(", ")}`
            : `用户 ${uid} 当日已签（无奖励）`,
        );
        if (flags.json) {
          output(r, flags);
        }
        return;
      }
      const st = await adminService.getCheckInState(uid);
      if (flags.json) {
        output(st, flags);
        return;
      }
      console.log(`用户 ${uid} 签到状态：组「${st.groupTitle}」(${st.groupId})`);
      console.log(
        `  已签 ${st.rewardIndex >= 0 ? st.rewardIndex + 1 : 0}/${st.total} 档 | 今日可签 ${st.canCheckIn ? "是" : "否"}`,
      );
      return;
    }
    case "daily": {
      const uid = args[1];
      if (!uid) {
        console.error("用法: users daily <uid>");
        process.exitCode = 1;
        return;
      }
      const r = await adminService.dailyRoutine(uid);
      console.log(`已对用户 ${uid} 执行一键日常：刷新完成 + 签到「${r.checkin}」`);
      return;
    }
    default:
      console.error(`未知 users 子命令: ${sub ?? ""}`);
      process.exitCode = 1;
  }
}

/** mail 子命令 */
async function runMail(args: string[], flags: { [key: string]: string }): Promise<void> {
  const sub = args[0];
  if (sub === "templates") {
    const list = adminService.getMailTemplates();
    if (flags.json) {
      output(list, flags);
      return;
    }
    if (!list.length) {
      console.log("暂无邮件模板");
      return;
    }
    console.table(
      list.map((t) => ({ 名称: t.name, 标题: t.subject, 附件种数: t.items.length })),
    );
    return;
  }
  if (sub === "send") {
    const target = args[1];
    let subject = args[2];
    let content = args.slice(3).join(" ");
    let items: { id: string; count: number }[] = [];
    // 模板发送：--template 名称（支持 {date} 等占位符替换）
    if (flags.template && flags.template !== "true") {
      const { expandTemplate } = await import("@ops/admin/mail-templates");
      const t = expandTemplate(flags.template, {
        date: new Date().toLocaleDateString(),
      });
      if (!t) {
        console.error(`未知邮件模板: ${flags.template}（可用 mail templates 查看）`);
        process.exitCode = 1;
        return;
      }
      subject = t.subject;
      content = t.content;
      items = t.items;
    }
    if (!target || !subject) {
      console.error("用法: mail send <uid[,uid...]|all> <subject> [content] [--items id:count,...] | mail send <uid|all> --template <名称>");
      process.exitCode = 1;
      return;
    }
    if (!items.length) {
      items = (flags.items ?? "")
        .split(",")
        .filter(Boolean)
        .map((pair) => {
          const [id, cnt] = pair.split(":");
          return { id, count: Number(cnt ?? 1) };
        });
    }
    if (target === "all") {
      const result = await adminService.sendMailAll({ subject, content, items });
      console.log(`已向 ${result.sent} 个用户群发邮件「${subject}」（附件 ${items.length} 种）`);
    } else {
      const uids = target.split(",").map((s) => s.trim()).filter(Boolean);
      for (const uid of uids) {
        const mail = await adminService.sendMail(uid, { subject, content, items });
        console.log(`已向用户 ${uid} 发送邮件 mailId=${mail.mailId}（附件 ${items.length} 种）`);
      }
    }
    return;
  }
  if (sub === "list") {
    const uid = args[1];
    if (!uid) {
      console.error("用法: mail list <uid> [--json]");
      process.exitCode = 1;
      return;
    }
    const mails = await adminService.listMails(uid);
    if (flags.json) {
      output(mails, flags);
      return;
    }
    if (!mails.length) {
      console.log(`用户 ${uid} 暂无邮件`);
      return;
    }
    console.table(
      mails.map((m) => ({
        mailId: m.mailId,
        标题: m.subject,
        已领: m.receiveAt !== -1 ? "是" : "否",
        附件: m.items.map((it) => `${it.name}x${it.count}`).join(", ") || "-",
        时间: new Date(m.createAt * 1000).toLocaleString(),
      })),
    );
    return;
  }
  if (sub === "delete") {
    const uid = args[1];
    const mailId = Number(args[2]);
    if (!uid || !Number.isInteger(mailId)) {
      console.error("用法: mail delete <uid> <mailId>");
      process.exitCode = 1;
      return;
    }
    const ok = await adminService.deleteMail(uid, mailId);
    if (!ok) {
      console.error(`邮件不存在: ${mailId}`);
      process.exitCode = 1;
      return;
    }
    console.log(`已删除用户 ${uid} 的邮件 mailId=${mailId}`);
    return;
  }
  console.error("用法: mail send <uid|all> ... | mail list <uid> | mail delete <uid> <mailId>");
  process.exitCode = 1;
}

/** server 子命令 */
async function runServer(args: string[], flags: { [key: string]: string }): Promise<void> {
  const sub = args[0];
  if (sub === "status") {
    const st = await adminService.status();
    console.log(`DoctorateTs 服务器状态`);
    console.log(`  端口 ${st.port} | 离线模式 ${st.offline} | 运行时间 ${st.uptime}s`);
    console.log(`  客户端版本 ${st.clientVersion} | 资源版本 ${st.resVersion}`);
    console.log(`  用户数 ${st.userCount} | 数据总量 ${(st.totalDataKB / 1024).toFixed(1)}MB | 内存 ${st.memoryMB ?? "-"}MB`);
    console.table(
      st.dataFiles.map((f) => ({
        文件: f.path,
        存在: f.exists,
        大小: `${(f.size / 1024).toFixed(1)}KB`,
      })),
    );
    return;
  }
  if (sub === "refresh") {
    const uid = args[1];
    if (!uid) {
      console.error("用法: server refresh <uid>");
      process.exitCode = 1;
      return;
    }
    await adminService.refreshUser(uid);
    console.log(`已触发用户 ${uid} 的每日/每周刷新`);
    return;
  }
  if (sub === "save") {
    const uid = args[1];
    if (uid) {
      await adminService.saveUser(uid);
      console.log(`已保存用户 ${uid} 存档`);
    } else {
      const users = await adminService.listUsers();
      for (const u of users) {
        await adminService.saveUser(u.uid);
      }
      console.log(`已保存全部 ${users.length} 个用户存档`);
    }
    return;
  }
  if (sub === "check") {
    if (flags.files === "true") {
      const r = await adminService.checkDataFiles();
      console.log(`存档文件级校验：${r.files.length} 个文件 ${r.ok ? "全部正常" : "存在异常"}`);
      console.table(
        r.files.map((f) => ({ uid: f.uid, 状态: f.ok ? "正常" : "异常", 详情: f.error ?? "-" })),
      );
      return;
    }
    const r = await adminService.checkData();
    console.log(`数据完整性校验：${r.ok ? "全部正常" : "存在异常"}`);
    console.table(
      r.users.map((u) => ({ uid: u.uid, 状态: u.ok ? "正常" : "异常", 详情: u.error ?? "-" })),
    );
    return;
  }
  console.error("用法: server status | server refresh <uid> | server save [uid] | server check [--files]");
  process.exitCode = 1;
}

/** config 子命令 */
async function runConfig(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "show") {
    console.log(JSON.stringify(config, null, 2));
  } else if (sub === "set") {
    const key = args[1];
    const value = args[2];
    if (!key || value === undefined) {
      console.error("用法: config set <key> <value>");
      process.exitCode = 1;
      return;
    }
    // config.json 是「类型上有键、运行时可手工扩展」的 JSON 文档——按路径就地读写
    const cfg = readJsonSync<JsonObject>("./data/config.json");
    const path = key.split(".");
    let cur: JsonObject = cfg;
    for (let i = 0; i < path.length - 1; i++) {
      // 与原实现同语义：nullish 中间段补空对象，其余原样下钻（标量中间段会在下一步赋值时报错）
      cur = (cur[path[i]] ??= {}) as JsonObject;
    }
    const raw: string = value;
    const parsed: JsonValue =
      raw === "true" ? true : raw === "false" ? false : /^\d+$/.test(raw) ? Number(raw) : raw;
    cur[path[path.length - 1]] = parsed;
    await writeJson("./data/config.json", cfg);
    console.log(`已修改 ${key} = ${JSON.stringify(parsed)}（重启后生效）`);
  } else {
    console.error("用法: config show | config set <key> <value>");
    process.exitCode = 1;
  }
}

/** logs 子命令（统一日志管理：审计 / 服务器 / 看门狗） */
async function runLogs(args: string[], flags: { [key: string]: string }): Promise<void> {
  const sub = args[0];
  // 审计日志（sub=show 为旧命令别名）
  if (sub === "show" || sub === "audit") {
    const last = Number(flags.last ?? 50);
    const entries = await logService.readAuditLog({
      action: flags.action,
      uid: flags.uid,
      q: flags.q,
      limit: Number.isFinite(last) ? last : 50,
    });
    if (flags.json) {
      output(entries, flags);
      return;
    }
    if (!entries.length) {
      console.log("暂无操作日志");
      return;
    }
    console.table(
      entries.map((e) => ({
        时间: new Date(e.ts * 1000).toLocaleString(),
        操作: e.action,
        用户: e.uid || "-",
        详情: e.detail,
      })),
    );
    return;
  }
  if (sub === "clear") {
    if (flags.yes !== "true") {
      console.error("危险操作：清空全部审计日志请加 --yes");
      process.exitCode = 1;
      return;
    }
    const r = await adminService.clearLogs("CLEAR");
    console.log(`已清空 ${r.cleared} 条审计日志`);
    return;
  }
  if (sub === "server") {
    const last = Number(flags.last ?? 100);
    const r = await logService.readServerLog({
      date: flags.date,
      level: flags.level,
      tag: flags.tag,
      q: flags.q,
      limit: Number.isFinite(last) ? last : 100,
    });
    if (flags.json) {
      output(r, flags);
      return;
    }
    if (!r.items.length) {
      console.log("无匹配的服务器日志");
      return;
    }
    console.log(`共 ${r.total} 条（显示 ${r.items.length}）:`);
    for (const e of r.items) {
      console.log(`  ${e.ts} [${e.level}] [${e.tag}] ${e.text}`);
    }
    return;
  }
  if (sub === "watchdog") {
    const r = await logService.readWatchdogLog();
    if (flags.json) {
      output(r, flags);
      return;
    }
    if (!r.entries.length) {
      console.log("暂无看门狗日志");
      return;
    }
    for (const e of r.entries) {
      console.log(`  ${e.file} | ${e.line}`);
    }
    return;
  }
  if (sub === "server-clear") {
    if (flags.yes !== "true") {
      console.error("危险操作：清空全部服务器日志请加 --yes");
      process.exitCode = 1;
      return;
    }
    const r = await logService.clearServerLogs("CLEAR");
    console.log(`已清空 ${r.cleared} 个服务器日志文件`);
    return;
  }
  console.error("用法: logs show|audit [--last N] [--action x] [--uid x] [--json] | logs server [--date YYYYMMDD] [--level x] [--tag x] [--last N] [--json] | logs watchdog [--json] | logs clear --yes | logs server-clear --yes");
  process.exitCode = 1;
}

/** capture 子命令（统一抓包管理） */
async function runCapture(args: string[], flags: { [key: string]: string }): Promise<void> {
  await captureManager.init();
  const sub = args[0];
  if (sub === "sessions") {
    const sessions = await captureManager.listSessions();
    if (flags.json) {
      output(sessions, flags);
      return;
    }
    if (!sessions.length) {
      console.log("暂无抓包会话（记录会自动归入「自动-日期」会话）");
      return;
    }
    console.table(
      sessions.map((s) => ({
        id: s.id,
        名称: s.name,
        来源: s.source,
        开始: new Date(s.startedAt).toLocaleString(),
        状态: s.endedAt ? "已结束" : "运行中",
        记录数: s.recordCount,
      })),
    );
    return;
  }
  if (sub === "start") {
    const name = args[1] ?? "未命名会话";
    const source = (flags.source ?? "private") as "private";
    const s = await captureManager.startSession(name, source, "CLI 新建会话");
    console.log(`已新建会话「${s.name}」(${s.id}) [${s.source}]`);
    return;
  }
  if (sub === "stop") {
    const id = args[1];
    if (!id) {
      console.error("用法: capture stop <会话id>");
      process.exitCode = 1;
      return;
    }
    const ok = await captureManager.stopSession(id);
    if (!ok) {
      console.error(`会话不存在: ${id}`);
      process.exitCode = 1;
      return;
    }
    console.log(`已停止会话 ${id}`);
    return;
  }
  if (sub === "records") {
    const status = flags.status !== undefined ? Number(flags.status) : undefined;
    const result = await captureManager.query({
      sessionId: flags.session,
      source: flags.source,
      method: flags.method,
      path: flags.path,
      module: flags.module,
      endpoint: flags.endpoint,
      status: status !== undefined && Number.isFinite(status) ? status : undefined,
      q: flags.q,
      limit: Number(flags.limit ?? 50),
    });
    if (flags.json) {
      output(result, flags);
      return;
    }
    if (!result.items.length) {
      console.log("暂无匹配的抓包记录");
      return;
    }
    console.log(`共 ${result.total} 条（显示 ${result.items.length}）:`);
    console.table(
      result.items.map((r) => ({
        id: r.id,
        时间: new Date(r.ts).toLocaleString(),
        方法: r.method,
        路径: r.path,
        状态: r.status ?? "-",
        来源: r.source,
        延迟: r.latencyMs !== null && r.latencyMs !== undefined ? `${r.latencyMs.toFixed(1)}ms` : "-",
        响应: r.resSize ?? 0,
      })),
    );
    return;
  }
  if (sub === "show") {
    const id = args[1];
    if (!id) {
      console.error("用法: capture show <记录id|rid> [--json]");
      process.exitCode = 1;
      return;
    }
    const detail = await captureManager.getRecordDetail(id);
    if (!detail) {
      console.error(`记录不存在: ${id}`);
      process.exitCode = 1;
      return;
    }
    if (flags.json) {
      output(detail, flags);
      return;
    }
    console.log(`记录 ${detail.rid}（id=${detail.id}）[${detail.source}] ${detail.method ?? ""} ${detail.path ?? ""} → ${detail.status ?? "-"}`);
    console.log(`  时间 ${new Date(detail.ts).toLocaleString()} | 延迟 ${detail.latencyMs?.toFixed(1) ?? "-"}ms`);
    if (detail.reqHeaders) console.log(`  请求头 ${detail.reqHeaders}`);
    if (detail.reqBody !== undefined) console.log("  请求体:", JSON.stringify(detail.reqBody, null, 2));
    if (detail.resHeaders) console.log(`  响应头 ${detail.resHeaders}`);
    if (detail.resBody !== undefined) console.log("  响应体:", JSON.stringify(detail.resBody, null, 2));
    if (detail.missingFiles.length) console.log(`  ⚠ 缺失文件: ${detail.missingFiles.join(", ")}`);
    return;
  }
  if (sub === "stats") {
    output(await captureManager.stats(), flags);
    return;
  }
  if (sub === "clear") {
    if (flags.yes !== "true") {
      console.error("危险操作：清空全部抓包记录请加 --yes");
      process.exitCode = 1;
      return;
    }
    const r = await captureManager.clearAll("CLEAR");
    console.log(`已清空 ${r.cleared} 条抓包记录`);
    return;
  }
  if (sub === "export") {
    const id = args[1];
    if (!id) {
      console.error("用法: capture export <会话id>");
      process.exitCode = 1;
      return;
    }
    const out = await captureManager.exportSession(id);
    console.log(`已导出 ${out.records} 条记录 → ${out.path} (${out.size}B)`);
    return;
  }
  console.error("用法: capture sessions | start <名称> [--source x] | stop <会话id> | records [--path x] [--status n] [--source x] [--session id] [--limit n] [--json] | show <记录id|rid> [--json] | stats [--json] | export <会话id> | clear --yes");
  process.exitCode = 1;
}

/** gacha 子命令（卡池管理） */
async function runGacha(args: string[], flags: { [key: string]: string }): Promise<void> {
  const sub = args[0];
  if (sub === "pools") {
    const pools = adminService.listPools();
    if (flags.json) {
      output(pools, flags);
      return;
    }
    if (!pools.length) {
      console.log("暂无卡池数据");
      return;
    }
    console.table(
      pools.map((p) => ({
        poolId: p.poolId,
        名称: p.name,
        规则: p.ruleType,
        保底: p.guarantee5Count,
        开池: new Date(p.openTime * 1000).toLocaleDateString(),
        关池: new Date(p.endTime * 1000).toLocaleDateString(),
      })),
    );
    return;
  }
  if (sub === "pool") {
    const poolId = args[1];
    if (!poolId) {
      console.error("用法: gacha pool <poolId> [--json]");
      process.exitCode = 1;
      return;
    }
    const detail = adminService.poolDetail(poolId);
    if (!detail) {
      console.error(`卡池不存在: ${poolId}`);
      process.exitCode = 1;
      return;
    }
    if (flags.json) {
      output(detail, flags);
      return;
    }
    console.log(`卡池 ${detail.name}(${detail.poolId}) [${detail.ruleType}] 保底 ${detail.guarantee5Count}`);
    if (detail.upChars.length) {
      console.log("  UP 干员:");
      for (const c of detail.upChars) {
        console.log(`    ${c.name}(${c.charId}) ${c.percent}%`);
      }
    } else {
      console.log("  UP 干员:（无）");
    }
    console.log(`  可用干员 ${detail.availChars.length} 名 | 限时干员 ${detail.limitedChars.length} 名`);
    return;
  }
  if (sub === "state") {
    const uid = args[1];
    const poolId = args[2];
    if (!uid || !poolId) {
      console.error("用法: gacha state <uid> <poolId> [--json]");
      process.exitCode = 1;
      return;
    }
    const st = await adminService.getPlayerPoolState(uid, poolId);
    if (flags.json) {
      output(st, flags);
      return;
    }
    console.log(`玩家 ${uid} 卡池「${st.name}」(${st.poolId}) [${st.ruleType}]`);
    console.log(
      `  UP 选择: ${st.upChars.map((c) => `${c.name}(${c.charId})`).join(", ") || "（未选择）"}`,
    );
    console.log(`  保底计数: ${st.beforeNonHitCnt} / ${st.guarantee5Count}`);
    return;
  }
  if (sub === "up") {
    const uid = args[1];
    const poolId = args[2];
    const charIds = args.slice(3);
    if (!uid || !poolId) {
      console.error("用法: gacha up <uid> <poolId> [charId...]（空 = 清除 UP）");
      process.exitCode = 1;
      return;
    }
    const st = await adminService.setPlayerPoolUp(uid, poolId, charIds);
    console.log(
      `已设置玩家 ${uid} 卡池 ${poolId} UP: ${st.upChars.map((c) => c.name).join(", ") || "（清除）"}`,
    );
    return;
  }
  if (sub === "pity") {
    const uid = args[1];
    const ruleType = args[2];
    const countStr = args[3];
    if (!uid) {
      console.error("用法: gacha pity <uid> [ruleType] [count]（无 count 查看，有则设置）");
      process.exitCode = 1;
      return;
    }
    if (ruleType && countStr !== undefined) {
      const count = Number(countStr);
      if (!Number.isInteger(count) || count < 0) {
        console.error("保底计数必须为非负整数");
        process.exitCode = 1;
        return;
      }
      const r = await adminService.setPlayerPity(uid, ruleType, count);
      console.log(`已设置玩家 ${uid} ${r.ruleType} 保底计数 = ${r.beforeNonHitCnt}`);
      return;
    }
    if (ruleType) {
      const r = await adminService.getPlayerPity(uid, ruleType);
      if (flags.json) {
        output(r, flags);
        return;
      }
      console.log(`玩家 ${uid} ${r.ruleType} 保底计数 = ${r.beforeNonHitCnt}`);
      return;
    }
    const list = await adminService.listPlayerPity(uid);
    if (flags.json) {
      output(list, flags);
      return;
    }
    if (!list.length) {
      console.log(`玩家 ${uid} 暂无保底记录`);
      return;
    }
    console.table(
      list.map((r) => ({ 规则: r.ruleType, 保底计数: r.beforeNonHitCnt })),
    );
    return;
  }
  console.error("用法: gacha pools | pool <poolId> | state <uid> <poolId> | up <uid> <poolId> [charId...] | pity <uid> [ruleType] [count]");
  process.exitCode = 1;
}

/** official 子命令（官服账号迁移） */
/**
 * 手动触发 single 模式满配账号刷新（C-1）
 *
 * singleAutoMaxAccount 关闭后不再随版本自动刷新；此命令按需合并式刷新
 * （内容字段以 player_data.json 基底刷新，进度字段保留——S1 语义）。
 * @param args - [uid?]（缺省 singleUid）
 */
async function runMaxAccount(args: string[]): Promise<void> {
  const { accountManager } = await import("@game/modules/account/account-manager");
  const config = (await import("@core/config/index")).default;
  const uid = args[0] || config.singleUid || "1";
  const player = await accountManager.getPlayerData(uid);
  const { generateMaxedAccount } = await import("../scripts/generate-max-account");
  await generateMaxedAccount(player);
  await accountManager.flushSave(uid);
  console.log(`已按当前数据版本刷新满配账号 ${uid}（合并式刷新——进度字段保留）`);
}

/** pay 子命令：订单管理（支付流程：createOrder → confirm → deliver） */
async function runPay(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "orders") {
    const uid = args[1];
    const orders = await adminService.listPayOrders(uid);
    if (args.includes("--json")) {
      output(orders, { json: "1" });
      return;
    }
    if (!orders.length) {
      console.log(uid ? `用户 ${uid} 无订单` : "无订单");
      return;
    }
    console.table(
      orders.map((o) => ({
        订单号: o.orderId,
        用户: o.uid,
        商品: o.goodId,
        金额分: o.amount,
        状态: o.status,
        创建时间: new Date(o.createdAt * 1000).toISOString().slice(0, 19),
      })),
    );
    return;
  }
  if (sub === "order" && args[1] === "confirm") {
    const orderId = args[2];
    if (!orderId) {
      console.error("用法: pay order confirm <orderId>");
      process.exitCode = 1;
      return;
    }
    const r = await adminService.confirmPayOrder(orderId);
    if (!r.ok || !r.order) {
      console.error(`订单 ${orderId} 不存在或已发货`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `订单 ${orderId} 已标记支付（${r.order.goodId}，状态 ${r.order.status}）——客户端 confirmOrder 时发货`,
    );
    return;
  }
  console.error("用法: pay orders [uid] [--json] | pay order confirm <orderId>");
  process.exitCode = 1;
}

/**
 * 把 CLI 的官服子命令收窄为受支持操作
 *
 * 迁移前此处为 `sub as any`——`--action` 来自命令行，属外部输入，应经运行时白名单
 * （{@link isOfficialAction}）收窄后再透传给官方调用层。
 * @param sub - 子命令名
 * @returns 受支持的官服操作
 * @throws 子命令不在白名单时
 */
function asOfficialAction(sub: string): OfficialAction {
  if (!isOfficialAction(sub)) throw new Error(`不支持的官服操作: ${sub}`);
  return sub;
}

/**
 * 读取官服 JSON 响应字段（仅用于 CLI 打印）
 * @param data - 响应数据（外部未建模 JSON）
 * @param key - 字段名
 * @returns 字段值；非对象或缺失时为 undefined（打印效果与迁移前的直接属性访问一致）
 */
function officialField(data: JsonValue | undefined, key: string): JsonValue | undefined {
  return data !== undefined && isJsonObject(data) ? data[key] : undefined;
}

async function runOfficial(
  args: string[],  flags: { [key: string]: string },
): Promise<void> {
  const sub = args[0];
  if (sub === "accounts") {
    const file = args[1];
    if (!file) {
      console.error("用法: official accounts <file> [--json]");
      process.exitCode = 1;
      return;
    }
    const { parseAccounts } = await import("../scripts/migrate-official");
    const list = parseAccounts(readFileSync(file, "utf8"));
    if (flags.json) {
      output(list, flags);
      return;
    }
    if (!list.length) {
      console.log("未解析到账号（每行 手机号 密码，或两行一组 手机号\\n密码）");
      return;
    }
    console.table(
      list.map((a) => ({ 手机号: a.phone, 密码: a.pwd })),
    );
    return;
  }
  if (sub === "migrate") {
    const file = args[1];
    const templateUid = flags.template ?? "1";
    if (!file) {
      console.error("用法: official migrate <accounts文件> [--template uid]");
      process.exitCode = 1;
      return;
    }
    if (!(await import("fs")).existsSync(file)) {
      console.error(`账号文件不存在: ${file}`);
      process.exitCode = 1;
      return;
    }
    console.log("开始官服迁移（需公网访问官服，逐账号执行，请稍候）...");
    const results = await adminService.migrateOfficial(
      readFileSync(file, "utf8"),
      templateUid,
    );
    if (flags.json) {
      output(results, flags);
      return;
    }
    const ok = results.filter((r) => !r.error).length;
    for (const r of results) {
      if (r.error) {
        console.log(`  [失败] ${r.phone}: ${r.error}`);
      } else {
        console.log(`  [成功] ${r.phone} → uid=${r.uid} 昵称=${r.nickName}`);
      }
    }
    console.log(`迁移完成：${ok}/${results.length} 成功`);
    return;
  }
  // 官服操作：status/signin/mails/receive/daily <phone> <pwd>
  const ACTIONS = ["status", "signin", "mails", "receive", "daily"];
  if (sub === "backend") {
    const b = adminService.getOfficialBackend();
    if (flags.json) {
      output(b, flags);
      return;
    }
    console.log(`官服操作后端：${b.enabled ? "自定义" : "官方（默认）"}`);
    console.log(`  游戏 ${b.game}`);
    console.log(`  账号 ${b.account}`);
    console.log(`  配置 ${b.conf}`);
    console.log('  自定义：config set officialBackend.enabled true / config set officialBackend.game <url>（重启生效）');
    return;
  }
  if (ACTIONS.includes(sub)) {
    const phone = args[1];
    const pwd = args[2];
    if (!phone || !pwd) {
      console.error(`用法: official ${sub} <phone> <pwd>`);
      process.exitCode = 1;
      return;
    }
    console.log(`正在登录官服并执行「${sub}」...（需公网访问官服）`);
    const r = await adminService.officialAction(phone, pwd, asOfficialAction(sub));
    if (flags.json) {
      output(r, flags);
      return;
    }
    if (!r.ok) {
      console.log(`[未执行] ${r.reason ?? "失败"}`);
      return;
    }
    if (sub === "status") {
      const d = r.data;
      console.log(`官服账号 ${officialField(d, "nickName")}#${officialField(d, "nickNumber")}（uid=${officialField(d, "uid")}）Lv.${officialField(d, "level")}`);
      console.log(`  理智 ${officialField(d, "ap")}/${officialField(d, "maxAp")} | 龙门币 ${officialField(d, "gold")} | 源石 ${officialField(d, "androidDiamond")} | 社交点 ${officialField(d, "socialPoint")}`);
      console.log(`  绿票 ${officialField(d, "lggShard")} | 黄票 ${officialField(d, "hggShard")} | 今日可签 ${officialField(d, "canCheckIn") ? "是" : "否"}`);
      return;
    }
    if (sub === "mails") {
      console.log(`官服邮件：共 ${officialField(r.data, "count")} 封（未读 ${officialField(r.data, "unread")}）`);
      return;
    }
    console.log(`[成功] ${JSON.stringify(r.data ?? "")}`);
    return;
  }
  if (sub === "call") {
    const phone = args[1];
    const pwd = args[2];
    const cgi = args[3];
    if (!phone || !pwd || !cgi) {
      console.error('用法: official call <phone> <pwd> <cgi> [--body \'{"from":0}\']');
      process.exitCode = 1;
      return;
    }
    let body: JsonValue = {};
    if (flags.body && flags.body !== "true") {
      try {
        body = JSON.parse(flags.body);
      } catch {
        console.error("--body 不是合法 JSON");
        process.exitCode = 1;
        return;
      }
    }
    console.log(`正在登录官服并调用 ${cgi}...（需公网访问官服）`);
    const r = await adminService.officialCall(phone, pwd, cgi, body);
    if (flags.json) {
      output(r, flags);
      return;
    }
    console.log(`[${cgi}] ${JSON.stringify(r.result, null, 2)}`);
    return;
  }
  if (sub === "gacha-sync") {
    const phone = args[1];
    const pwd = args[2];
    if (!phone || !pwd) {
      console.error("用法: official gacha-sync <phone> <pwd> [--pools poolId,poolId...] [--refresh]");
      process.exitCode = 1;
      return;
    }
    const poolIds = flags.pools && flags.pools !== "true"
      ? flags.pools.split(",").map((s: string) => s.trim()).filter(Boolean)
      : undefined;
    const refresh = flags.refresh === "true";
    console.log(`正在登录官服并${refresh ? "全量刷新" : "补全"}卡池详情...（需公网；目标 ${poolIds ? poolIds.length : "本地全部"} 池，${refresh ? "不跳过已有" : "跳过已有"}）`);
    const r = await adminService.syncGachaPools(phone, pwd, poolIds, { refresh });
    if (flags.json) {
      output(r, flags);
      return;
    }
    console.log(`卡池同步完成：成功 ${r.ok}/${r.total} | 跳过已有 ${r.skipped} | 更新 ${r.updated} | 失败 ${r.failed.length}`);
    for (const f of r.failed) {
      console.log(`  [失败] ${f.poolId}: ${f.error}`);
    }
    console.log("已写入 data/gacha_detail_table.json（旧文件已备份 .bak；重启服务器后生效）");
    return;
  }
  console.error("用法: official migrate <accounts文件> [--template uid] | official accounts <file> [--json] | official <status|signin|mails|receive|daily> <phone> <pwd> | official call <phone> <pwd> <cgi> [--body] | official gacha-sync <phone> <pwd> [--pools ...]");
  process.exitCode = 1;
}

/** 活动管理（自定义活动切换：时间冻结 + 强制开启 + 合约赛季 + 资产补全） */
async function runActivities(
  args: string[],
  flags: { [key: string]: string },
): Promise<void> {
  const sub = args[0];
  const fmt = (ts: number) =>
    ts ? new Date(ts * 1000).toLocaleString("zh-CN", { hour12: false }) : "-";
  if (sub === "list" || !sub) {
    const list = await adminService.listActivities();
    if (flags.json) {
      output(list, flags);
      return;
    }
    console.log(
      `时间: ${list.usingOverride ? `冻结 ${list.timestamp}（${fmt(list.timestamp)}）` : "真实时间"} · 生效 ${list.effectiveTs}（${fmt(list.effectiveTs)}）`,
    );
    console.log(
      `合约赛季: V1=${list.crisisV1}（可用 ${list.crisisSeasons.v1.join(",")}）· V2=${list.crisisV2}（可用 ${list.crisisSeasons.v2.join(",")}）`,
    );
    console.log(
      `强制开启: ${list.forceOpen.length ? list.forceOpen.join(",") : "（无）"} · 自动补全: ${list.autoBackfill ? "开" : "关"}`,
    );
    console.log(
      `开放活动: 窗口内 ${list.activities.filter((a) => a.open).length} 个 + 强制 ${list.forceOpen.length} 个`,
    );
    const rows = list.activities
      .filter((a) => a.forced || a.open)
      .map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        状态: a.forced ? "强制开启" : a.open ? "开放" : "",
        开始: fmt(a.startTime),
        结束: fmt(a.rewardEndTime),
      }));
    if (rows.length) console.table(rows);
    else console.log("当前无开放/强制活动");
    return;
  }
  if (sub === "switch") {
    const tsRaw = args[1];
    let timestamp: number | undefined;
    if (tsRaw === "-") timestamp = -1;
    else if (tsRaw !== undefined) {
      timestamp = Number(tsRaw);
      if (!Number.isFinite(timestamp)) {
        console.error(`时间戳非法: ${tsRaw}`);
        process.exitCode = 1;
        return;
      }
    }
    const forceOpen =
      flags.force && flags.force !== "true"
        ? flags.force.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;
    const r = await adminService.switchActivity({
      timestamp,
      forceOpen,
      crisisV1: flags.crisisV1 && flags.crisisV1 !== "true" ? flags.crisisV1 : undefined,
      crisisV2: flags.crisisV2 && flags.crisisV2 !== "true" ? flags.crisisV2 : undefined,
    });
    console.log(
      `已切换: 时间戳=${r.timestamp}（生效 ${r.effectiveTs}）· 合约 V1=${r.crisisV1} V2=${r.crisisV2} · 强制开启 ${r.forceOpen.length} 个 · 开放 ${r.openCount} 个`,
    );
    if (r.backfillTasks.length) {
      console.log(`资产补全任务: ${r.backfillTasks.join(", ")}（activities backfill-status <id> 查看进度）`);
    }
    return;
  }
  if (sub === "crisis") {
    // 仅切换合约赛季（不动时间戳）
    const r = await adminService.switchActivity({
      crisisV1: flags.v1 && flags.v1 !== "true" ? flags.v1 : undefined,
      crisisV2: flags.v2 && flags.v2 !== "true" ? flags.v2 : undefined,
    });
    console.log(`合约赛季已切换: V1=${r.crisisV1} V2=${r.crisisV2}`);
    return;
  }
  if (sub === "force") {
    // 仅设置强制开启（不动时间戳）
    const forceOpen =
      flags.ids && flags.ids !== "true"
        ? flags.ids.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
    const r = await adminService.switchActivity({ forceOpen });
    console.log(`强制开启已更新: ${r.forceOpen.length ? r.forceOpen.join(", ") : "（清空）"}`);
    return;
  }
  if (sub === "backfill") {
    const target = args[1];
    if (!target) {
      console.error("用法: activities backfill <all|活动id|危机赛季id> [--platform Windows|Android]");
      process.exitCode = 1;
      return;
    }
    const task = await adminService.backfillAssets(
      target,
      flags.platform && flags.platform !== "true" ? flags.platform : "Android",
    );
    console.log(`资产补全任务已启动: ${task.id}（target=${target}）`);
    return;
  }
  if (sub === "backfill-status") {
    const id = args[1];
    if (!id) {
      console.error("用法: activities backfill-status <任务id>");
      process.exitCode = 1;
      return;
    }
    const task = adminService.getBackfillTaskStatus(id);
    if (!task) {
      console.error(`任务不存在: ${id}`);
      process.exitCode = 1;
      return;
    }
    if (flags.json) {
      output(task, flags);
      return;
    }
    console.log(`任务 ${task.id}: ${task.status}（target=${task.target} platform=${task.platform}）`);
    if (task.stats) {
      console.log(
        `候选 ${task.stats.candidates} · 已有 ${task.stats.local} · 补全 ${task.stats.downloaded} · 失败 ${task.stats.failed}`,
      );
      if (task.stats.files.length) {
        console.log(
          `补全文件(${task.stats.files.length}): ${task.stats.files.slice(0, 20).join(", ")}${task.stats.files.length > 20 ? " ..." : ""}`,
        );
      }
    }
    if (task.error) console.log(`错误: ${task.error}`);
    return;
  }
  console.error(
    "用法: activities list | activities switch <timestamp|-1> [--force id1,id2] [--crisisV1 ccN] [--crisisV2 ccN] | activities crisis [--v1 ccN] [--v2 ccN] | activities force [--ids id1,id2] | activities backfill <all|活动id|危机赛季id> [--platform x] | activities backfill-status <id>",
  );
  process.exitCode = 1;
}

/** tools 子命令帮助 */
function printToolsHelp(): void {
  console.log(`DoctorateTs 开发工具（统一入口）
用法: pnpm run admin -- tools <name> [args...]
  tools validate-excel [--tables t1,t2] [--full <file>] [--raw]    excel 类型闭包覆盖校验
  tools validate-playerdata [--input <json>] [--types <ts>] [--root <path>] [--full <file>]  玩家数据线格式校验
  tools dump-definedfix [<mod.dat 路径>]                          解出 DefinedFix.lua 明文验证注入
  tools check-plugin-deps [<mod.dat 路径>]                        校验插件 require 依赖图
  tools dump-gateway-dict [rid]                                   网关协议字典（扫描抓包消息形态）
  tools parse-arkhub [rid]                                        重解析网关抓包为 parsed.json/messages.json
  tools help                                                       显示本帮助`);
}

/** tools 子命令：统一调度散落的开发工具（各工具导出 main(argv)，此处分派调用） */
async function runTools(raw: string[]): Promise<void> {
  const name = raw[0];
  const toolArgs = raw.slice(1);
  if (!name || name === "help" || name === "-h" || name === "--help") {
    printToolsHelp();
    return;
  }
  const MODS: Record<string, () => Promise<{ main: (argv: string[]) => Promise<void> | void }>> = {
    "validate-excel": () => import("./validate-excel-json"),
    "validate-playerdata": () => import("./validate-playerdata-json"),
    "dump-definedfix": () => import("./dump-definedfix"),
    "check-plugin-deps": () => import("./check-plugin-deps"),
    "dump-gateway-dict": () => import("./dump-gateway-dict"),
    "parse-arkhub": () => import("./parse-arkhub-gateway"),
  };
  const load = MODS[name];
  if (!load) {
    console.error(`未知 tools 子命令: ${name}`);
    printToolsHelp();
    process.exitCode = 1;
    return;
  }
  const mod = await load();
  await mod.main(toolArgs);
}

/** 命令分发（main 与交互模式共用） */
export async function dispatch(
  command: string,
  args: string[],
  flags: { [key: string]: string },
): Promise<void> {
  switch (command) {
    case "users":
      await runUsers(args, flags);
      break;
    case "activities":
      await runActivities(args, flags);
      break;
    case "mail":
      await runMail(args, flags);
      break;
    case "server":
      await runServer(args, flags);
      break;
    case "config":
      await runConfig(args);
      break;
    case "logs":
      await runLogs(args, flags);
      break;
    case "capture":
      await runCapture(args, flags);
      break;
    case "gacha":
      await runGacha(args, flags);
      break;
    case "pay":
      await runPay(args);
      break;
    case "official":
      await runOfficial(args, flags);
      break;
    case "max-account":
      await runMaxAccount(args);
      break;
    case "tools":
      // 重建原始 argv：位置参数在前，布尔 flag 只带键，带值 flag 补值
      {
        const raw: string[] = [...args];
        for (const [k, v] of Object.entries(flags)) {
          raw.push(`--${k}`);
          if (v !== "true") raw.push(v);
        }
        await runTools(raw);
      }
      break;
    case "help":
    case "-h":
    case "--help":
      printHelp();
      break;
    default:
      console.error(`未知命令: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

/** 交互模式：逐行执行命令，help/exit 退出（Tab 补全命令名） */
function runRepl(): void {
  console.log("DoctorateTs 管理交互模式（输入 help 查看命令，exit 退出；Tab 补全）");
  const COMMANDS = ["users", "mail", "server", "config", "gacha", "pay", "official", "logs", "capture", "activities", "tools", "help", "exit", "quit"];
  const completer = (line: string): [string[], string] => {
    const hits = COMMANDS.filter((c) => c.startsWith(line));
    return [hits.length ? hits : COMMANDS, line];
  };
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "admin> ",
    completer,
  });
  let pending = 0;
  rl.prompt();
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }
    const { command, args, flags } = parseArgs(trimmed.split(/\s+/));
    if (command === "exit" || command === "quit") {
      rl.close();
      return;
    }
    pending++;
    try {
      await dispatch(command, args, flags);
    } catch (err) {
      console.error("[admin] 执行失败:", (err as Error).message ?? err);
    } finally {
      pending--;
      rl.prompt();
    }
  });
  rl.on("close", async () => {
    console.log("再见");
    // 管道输入时 stdin 立即 EOF：等待进行中的命令输出完成再退出，避免截断
    while (pending > 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
    process.exit(0);
  });
}

/** 主入口 */
export async function main(): Promise<void> {
  // 全局 --quiet/-q：抑制 CLI 内部 INFO 日志（便于脚本化）。
  // 先剔除该 flag 再 parseArgs（parseArgs 会把 --quiet 后的下一个 token 当值吞掉）
  const rawArgv = process.argv.slice(2);
  if (rawArgv.includes("--quiet") || rawArgv.includes("-q")) {
    process.env.LOG_LEVEL = "error";
  }
  const argv = rawArgv.filter((a) => a !== "--quiet" && a !== "-q");
  const { command, args, flags } = parseArgs(argv);
  if (!command) {
    await cliInit();
    runRepl();
    return;
  }
  if (command === "help" || command === "-h" || command === "--help") {
    printHelp();
    return;
  }
  // tools 命令组下的纯开发工具无需初始化 excel/账户数据
  if (command !== "tools") {
    await cliInit();
  }
  await dispatch(command, args, flags);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[admin-cli] 执行失败:", err.message ?? err);
    process.exit(1);
  });
}
