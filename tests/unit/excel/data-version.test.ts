import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  checkDataVersion,
  parseDataVersionFile,
  verifyLocalDataVersion,
} from "@core/data/data-version";

/**
 * 数据版本一致性校验（S10）：data_version.txt 的 VersionControl vs gamedata_const.dataVersion
 */
describe("data-version（数据版本校验）", () => {
  it("parseDataVersionFile：解析 Stream / Change / VersionControl 三行", () => {
    const txt = [
      "Stream://torappu-data/v076/rel76.0",
      "Change:120163 on 2026/08/06",
      "VersionControl:76.2.0",
    ].join("\n");
    expect(parseDataVersionFile(txt)).toEqual({
      stream: "//torappu-data/v076/rel76.0",
      change: "120163 on 2026/08/06",
      versionControl: "76.2.0",
    });
  });

  it("parseDataVersionFile：空内容/杂行/大小写不敏感", () => {
    expect(parseDataVersionFile("")).toEqual({});
    expect(parseDataVersionFile("# comment\nversioncontrol : 75.1.0")).toEqual({
      versionControl: "75.1.0",
    });
  });

  it("checkDataVersion：一致 → ok；不一致 → 报错文案含两侧版本号", () => {
    expect(checkDataVersion("76.2.0", "76.2.0").ok).toBe(true);
    const bad = checkDataVersion("76.2.0", "75.1.0");
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("76.2.0");
    expect(bad.message).toContain("75.1.0");
  });

  it("checkDataVersion：任一侧缺失 → 不可判定（ok 为 true，文案标注缺失）", () => {
    expect(checkDataVersion(undefined, "76.2.0").ok).toBe(true);
    expect(checkDataVersion("76.2.0", undefined).message).toContain("不可判定");
    expect(checkDataVersion(undefined, undefined).message).toContain("缺失");
  });

  it("verifyLocalDataVersion：读取真实 data/excel 目录，当前两份版本一致", () => {
    const r = verifyLocalDataVersion(process.cwd());
    expect(r.ok).toBe(true);
    expect(r.fileVersion).toBeTruthy();
    expect(r.dataVersion).toBe(r.fileVersion);
  });

  it("verifyLocalDataVersion：目录不存在时判为不可判定（不抛错）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-dataversion-"));
    const r = verifyLocalDataVersion(dir);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("不可判定");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("verifyLocalDataVersion：两份版本不一致时 ok=false（模拟中断的更新）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-dataversion-"));
    fs.mkdirSync(path.join(dir, "data/excel"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "data/excel/data_version.txt"),
      "VersionControl:76.2.0\n",
    );
    fs.writeFileSync(
      path.join(dir, "data/excel/gamedata_const.json"),
      JSON.stringify({ dataVersion: "75.1.0" }),
    );
    const r = verifyLocalDataVersion(dir);
    expect(r.ok).toBe(false);
    expect(r.fileVersion).toBe("76.2.0");
    expect(r.dataVersion).toBe("75.1.0");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
