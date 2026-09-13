/**
 * 本地数据版本一致性校验
 *
 * 官服热更管线同时在 `data/excel/` 落下两份版本信息：
 * - `data_version.txt` —— 官服热更描述符（`Stream: //torappu-data/v076/rel76.0` /
 *   `Change: 120163 on 2026/08/06` / `VersionControl: 76.2.0`）
 * - `gamedata_const.json → dataVersion` —— excel 数据内嵌版本（实测同为 76.2.0）
 *
 * 修复（2026-09-09，S10）：此前全仓仅有类型声明引用 `dataVersion`，两份版本号不一致时**无任何告警**
 * ——更新中断/只转换了部分表时静默带着新旧混合数据启动。现提供解析与比对，供启动期与离线校验使用。
 */
import fs from "node:fs";
import path from "node:path";

import { logger } from "@utils/logger";
import { excelFilePath } from "./excel-data-dir";

/** data_version.txt 解析结果 */
export interface DataVersionDescriptor {
  /** `Stream:` 行（热更流地址） */
  stream?: string;
  /** `Change:` 行（变更号与日期） */
  change?: string;
  /** `VersionControl:` 行（版本号，如 76.2.0） */
  versionControl?: string;
}

/** 版本一致性校验结果 */
export interface DataVersionCheck {
  /** 两份版本是否一致（任一侧缺失时视为不可判定 → ok: true 但 ok=false 不适用，见 message） */
  ok: boolean;
  /** data_version.txt 中的版本号 */
  fileVersion?: string;
  /** gamedata_const.json 中的 dataVersion */
  dataVersion?: string;
  /** 人类可读结论 */
  message: string;
}

/**
 * 数据表批量新鲜度校验结果。
 *
 * 背景（修复 2026-09-11）：仅比对版本号无法发现「部分表未重转」——实测曾出现
 * 28/63 张表停留在旧批次、而 `dataVersion` 恰好与 `data_version.txt` 同为旧值，
 * 于是 S10 校验「假通过」。此校验改用**转换产物旁挂的溯源指纹**
 * （`data/excel/*.json.meta.json`，由 scripts/excel-convert.ts 的 writeMeta 落盘）
 * 判断各表是否来自同一次转换批次：以 `convertedAt`（转换时刻）的极差为准。
 *
 * 注意不要用 `sourceMtime`（原始解码文件的 mtime）作为判据——官服各 bundle 的
 * 下载/解码本身就有先后，实测跨度可达 1.5h，属正常；真正要发现的是
 * 「转换批次被切断」（如部分表转换失败被吞、或只跑了 `--table` 定向转换）。
 */
export interface TableFreshnessCheck {
  /** 是否所有表同批（无元数据时不可判定 → ok: true） */
  ok: boolean;
  /** 参与统计的表数 */
  total: number;
  /** 带溯源指纹的表数 */
  withMeta: number;
  /** 转换时刻跨度（毫秒），无元数据时为 0 */
  spreadMs: number;
  /** 最早的转换时刻（ISO），无元数据时 undefined */
  oldestAt?: string;
  /** 最晚的转换时刻（ISO），无元数据时 undefined */
  newestAt?: string;
  /** 原始解码文件的 mtime 跨度（毫秒，仅供参考，不作为判定依据） */
  sourceSpreadMs: number;
  /** 人类可读结论 */
  message: string;
}

/** 同批判定阈值：转换时刻跨度超过 30 分钟即视为混合刷新 */
export const FRESHNESS_SPREAD_TOLERANCE_MS = 30 * 60 * 1000;

/**
 * 解析 `data_version.txt`（逐行 `Key: Value`）
 * @param text - 文件内容
 * @returns 解析出的描述符（缺行则为 undefined）
 */
export function parseDataVersionFile(text: string): DataVersionDescriptor {
  const out: DataVersionDescriptor = {};
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "stream") out.stream = value;
    else if (key === "change") out.change = value;
    else if (key === "versioncontrol") out.versionControl = value;
  }
  return out;
}

/**
 * 比对两份版本号
 * @param fileVersion - `data_version.txt` 的 `VersionControl`（可缺失）
 * @param dataVersion - `gamedata_const.json` 的 `dataVersion`（可缺失）
 * @returns 校验结果（任一侧缺失时判为不可判定，ok 为 true，message 说明原因）
 */
export function checkDataVersion(
  fileVersion: string | undefined,
  dataVersion: string | undefined,
): DataVersionCheck {
  if (!fileVersion || !dataVersion) {
    return {
      ok: true,
      fileVersion,
      dataVersion,
      message: `数据版本不可判定（data_version.txt=${fileVersion ?? "缺失"}，gamedata_const=${dataVersion ?? "缺失"}）`,
    };
  }
  const ok = fileVersion === dataVersion;
  return {
    ok,
    fileVersion,
    dataVersion,
    message: ok
      ? `数据版本一致（${dataVersion}）`
      : `数据版本不一致：data_version.txt=${fileVersion} 而 gamedata_const.dataVersion=${dataVersion}（更新可能中断或仅转换了部分表）`,
  };
}

/**
 * 读取磁盘上的两份版本信息并比对（纯文件系统操作，无网络）
 * @param baseDir - 项目根目录（默认 cwd）
 * @returns 校验结果；文件不存在时按不可判定返回
 */
export function verifyLocalDataVersion(baseDir: string = process.cwd()): DataVersionCheck {
  let fileVersion: string | undefined;
  let dataVersion: string | undefined;
  try {
    const txt = fs.readFileSync(
      path.join(baseDir, "data/excel/data_version.txt"),
      "utf8",
    );
    fileVersion = parseDataVersionFile(txt).versionControl;
  } catch {
    /* 文件缺失 → 不可判定 */
  }
  try {
    const constTable = JSON.parse(
      fs.readFileSync(path.join(baseDir, "data/excel/gamedata_const.json"), "utf8"),
    ) as { dataVersion?: string };
    dataVersion = constTable?.dataVersion;
  } catch {
    /* 文件缺失 → 不可判定 */
  }
  return checkDataVersion(fileVersion, dataVersion);
}

/**
 * 校验 `data/excel/` 下各表是否来自同一转换批次（读取旁挂溯源指纹）。
 *
 * 判据：所有带 `<表>.json.meta.json` 的表，其 `convertedAt` 的极差（max - min）
 * 不超过 {@link FRESHNESS_SPREAD_TOLERANCE_MS}。极差过大说明有表停留在旧批次
 * （典型成因：转换阶段部分 worker 失败被吞、或只跑了 `--table` 定向转换）。
 *
 * 无任何元数据（旧数据 / 未走过新转换管线）→ 不可判定，`ok: true`，
 * 由 message 说明，避免对存量数据造成硬失败。
 *
 * @param baseDir - 项目根目录（默认 cwd）
 * @returns 新鲜度校验结果
 */
export function verifyTableFreshness(baseDir: string = process.cwd()): TableFreshnessCheck {
  const dir = path.join(baseDir, "data/excel");
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".meta.json"));
  } catch {
    return {
      ok: true,
      total: 0,
      withMeta: 0,
      spreadMs: 0,
      sourceSpreadMs: 0,
      message: "数据目录不存在，跳过新鲜度校验",
    };
  }

  const converted: number[] = [];
  const sources: number[] = [];
  for (const f of files) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, `${f}.meta.json`), "utf8")) as {
        sourceMtime?: number;
        convertedAt?: string;
      };
      if (typeof meta?.sourceMtime === "number") sources.push(meta.sourceMtime);
      const t = meta?.convertedAt ? Date.parse(meta.convertedAt) : NaN;
      if (Number.isFinite(t)) converted.push(t);
    } catch {
      /* 无元数据 → 跳过 */
    }
  }

  const sourceSpreadMs =
    sources.length > 1 ? Math.max(...sources) - Math.min(...sources) : 0;

  if (converted.length === 0) {
    return {
      ok: true,
      total: files.length,
      withMeta: sources.length,
      spreadMs: 0,
      sourceSpreadMs,
      message: `各表新鲜度不可判定（${files.length} 张表中 ${sources.length} 张有指纹但缺 convertedAt，无法判断是否同批刷新）`,
    };
  }

  const min = Math.min(...converted);
  const max = Math.max(...converted);
  const spreadMs = max - min;
  const ok = spreadMs <= FRESHNESS_SPREAD_TOLERANCE_MS;
  const mins = (spreadMs / 60_000).toFixed(1);
  return {
    ok,
    total: files.length,
    withMeta: converted.length,
    spreadMs,
    sourceSpreadMs,
    oldestAt: new Date(min).toISOString(),
    newestAt: new Date(max).toISOString(),
    message: ok
      ? `各表刷新批次一致（${converted.length}/${files.length} 张带指纹，转换跨度 ${mins} 分钟）`
      : `数据表刷新批次不一致：转换跨度 ${mins} 分钟（${converted.length}/${files.length} 张带指纹，` +
        `最早 ${new Date(min).toISOString()} / 最晚 ${new Date(max).toISOString()}）` +
        `——存在部分表未重转，建议重跑 \`pnpm run update\``,
  };
}

/**
 * 启动期校验已加载的 excel 数据版本（不阻断启动，仅告警）
 *
 * 与调用方传入的 `GameDataConst.dataVersion` 比对磁盘 `data_version.txt`；
 * 不一致时打 WARN，便于发现「更新中断 / 只转换了部分表」的混合数据状态。
 * 注：刻意不 import excel 单例（excel.ts 反向 import 本模块，避免循环依赖）。
 * @param dataVersion - 已加载的 `GameDataConst.dataVersion`
 * @returns 校验结果
 */
export function verifyLoadedDataVersion(dataVersion?: string): DataVersionCheck {
  const fileVersion = (() => {
    try {
      return parseDataVersionFile(
        fs.readFileSync(
          excelFilePath("./data/excel/data_version.txt"),
          "utf8",
        ),
      ).versionControl;
    } catch {
      return undefined;
    }
  })();
  const result = checkDataVersion(fileVersion, dataVersion);
  if (!result.ok) logger.warn("Excel", result.message);
  return result;
}
