/**
 * 迁移账号注册与存档写入
 *
 * 将转换后的私服存档写入 data/user/databases/{newUid}.json，
 * 并在主数据库（users 表）中注册账号（auth.phone 用官服手机号、auth.hgId 保留官服 uid）。
 * 新 uid 从现有账号最大值递增。
 */
import { writeFile as writeFileAsync } from "fs/promises";
import * as path from "path";
import { openDatabase } from "@core/db/database";
import { UserRepository } from "@core/db/user-repo";
import type { UserConfig } from "@game/modules/account/account-manager";
import type { OfficialPlayerData } from "./official-api";

const DATA_USER_DIR = path.join(__dirname, "../data/user");

/** 读取现有用户（主数据库——users.json 已迁移为种子）；返回类型由 UserRepository.getAll 精确推导 */
export async function loadUsers() {
  return new UserRepository(await openDatabase()).getAll();
}

/** 计算下一个新 uid（现有数字最大 +1，最小 2） */
export function nextUid(users: Record<string, UserConfig>): string {
  let max = 0;
  for (const key of Object.keys(users)) {
    const n = Number(key);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return String(max + 1);
}

/** 构造注册项（password 随机、auth 关联官服账号、社交/战斗等空结构） */
export function buildUserEntry(
  newUid: string,
  opts: { phone: string; officialUid: string },
): UserConfig {
  return {
    password: Math.random().toString(36).slice(2, 10),
    auth: {
      hgId: opts.officialUid,
      phone: opts.phone,
      email: "",
      identityNum: "",
      identityName: "",
      isMinor: false,
      isLatestUserAgreement: true,
    },
    uid: newUid,
    // 社交（social.db 唯一事实源）与回放/结算信息（replays/battle_infos 表）均不入 configs（R3/R4/A3）
    battle: { stageId: "" },
    gacha: {},
    rlv2: {},
  };
}

/**
 * 注册迁移账号
 * @returns 新 uid
 */
export async function registerImportedUser(opts: {
  phone: string;
  officialUid: string;
  convertedData: OfficialPlayerData;
}): Promise<{ uid: string; nickName: string }> {
  const users = await loadUsers();
  const newUid = nextUid(users);
  const entry = buildUserEntry(newUid, opts);

  // 1. 写入存档
  await writeFileAsync(
    path.join(DATA_USER_DIR, "databases", `${newUid}.json`),
    JSON.stringify(opts.convertedData),
    "utf8",
  );

  // 2. 注册账号（SQLite——users.json 已迁移为种子，不再写文件）
  users[newUid] = entry;
  await new UserRepository(await openDatabase()).upsert(newUid, entry);

  return {
    uid: newUid,
    nickName: opts.convertedData?.status?.nickName ?? "",
  };
}
