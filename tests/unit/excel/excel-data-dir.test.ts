/**
 * excel 数据目录解析测试
 *
 * 验证 app/core/data/excel-data-dir.ts：数据目录可覆写（分服 / 测试夹具），
 * 且 Excel 的懒加载表确实按当前目录读盘。
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_EXCEL_DATA_DIR,
  excelFilePath,
  getExcelDataDir,
  setExcelDataDir,
} from "@core/data/excel-data-dir";

afterEach(() => {
  setExcelDataDir(null);
  delete process.env.ARKNIGHTS_EXCEL_DIR;
});

describe("excel 数据目录解析", () => {
  it("默认目录沿用 ./data/excel，未匹配前缀的路径原样返回", () => {
    expect(DEFAULT_EXCEL_DATA_DIR).toBe("./data/excel");
    expect(getExcelDataDir()).toBe("./data/excel");
    expect(excelFilePath("./data/excel/item_table.json")).toBe("./data/excel/item_table.json");
    // 非 excel 目录的字面量（如 arkhub 数据）不受影响
    expect(excelFilePath("./data/arkhub/arkdex.json")).toBe("./data/arkhub/arkdex.json");
  });

  it("setExcelDataDir 覆写目录（末尾斜杠归一）", () => {
    setExcelDataDir("./data/excel-jp/");
    expect(getExcelDataDir()).toBe("./data/excel-jp/");
    expect(excelFilePath("./data/excel/item_table.json")).toBe("./data/excel-jp/item_table.json");
    setExcelDataDir(null);
    expect(getExcelDataDir()).toBe("./data/excel");
  });

  it("环境变量在无显式覆写时生效，显式覆写优先于环境变量", () => {
    process.env.ARKNIGHTS_EXCEL_DIR = "./data/excel-kr";
    expect(getExcelDataDir()).toBe("./data/excel-kr");
    setExcelDataDir("./data/excel-en");
    expect(getExcelDataDir()).toBe("./data/excel-en");
  });

  it("Excel 懒加载表按当前数据目录读盘（真实文件系统）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "excel-data-dir-"));
    fs.writeFileSync(
      path.join(dir, "clue_data.json"),
      JSON.stringify({ mafia: { id: "mafia", name: "叙拉古" } }),
      "utf-8",
    );
    try {
      setExcelDataDir(dir);
      const { Excel } = await import("@excel/excel");
      const excel = new Excel();
      expect(excel.ClueData).toEqual({ mafia: { id: "mafia", name: "叙拉古" } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
