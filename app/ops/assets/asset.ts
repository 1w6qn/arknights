import { Router } from "express";
import { basename, join, relative } from "path";
import { createHash } from "crypto";
import { crc32 } from "crc";
import axios from "axios";
import { EventEmitter } from "events";
import yauzl, { ZipFile } from "yauzl";
import { mkdir, readdir, readFile, writeFile, rename, stat } from "fs/promises";
import config from "../../core/config";
import { exists, size } from "@utils/file";
import { logger } from "@utils/logger";
import { isJsonObject, type JsonValue } from "@excel/json-value";
import { backfillFile } from "./asset-backfill";
import { assetRegistry } from "@asset/asset-service";
import {
  resolveRegion,
  resolveRegionCdn,
  resolveRegionCdnVersion,
  resolveRegionVersion,
} from "../../core/config/region";

const router = Router();

router.get(
  // fileName 用通配捕获多段：mod 清单 name 含子路径（如 anon/7d91430e114d86fef7d3b3511151e12d.bin），
  // 客户端按清单 name 构造下载路径，需能匹配 assets/.../<子路径>（path-to-regexp v8 命名通配 *name）
  "/official/:platform/assets/:assetsHash/*fileName",
  async (req, res) => {
    const { assetsHash, platform: platformParam } = req.params;
    // 平台决定用哪套 mod（Windows/Android 各自独立；未知平台回退 Android）
    const platform = platformParam ?? "Android";
    // 通配段（命名通配 *fileName 捕获为 string[]，含斜杠子路径）；空数组兜底（仅 assets/<hash>/ 无文件名）
    let fileName = (req.params.fileName as string[] | undefined ?? []).join("/" );
    // 资源版本跟随客户端请求路径（资源按版本存储——客户端从 hv 拿到 resVersion 拼路径）；
    // CDN 平台跟随客户端请求的 platform（Windows/Android 资源各自独立 CDN 目录，
    // 版本号不同——Windows 版本仅在 Windows CDN 可下载，Android 版本仅在 Android CDN 可下载）
    const version = assetsHash;
    const cdnPlatform = platform;
    // CDN 下载用官方原始版本（客户端请求的 assetsHash 是替换过 hash 的 mod 版本；
    // 官方 CDN 无 mod 版本，须按平台还原官方 resVersion）
    const cdnVersion = officialResVersion(platform);
    let basePath = join(__dirname, "..", "..", "..", "assets", version, "redirect");

    if (fileName === "hot_update_list.json" && config.assets.enableMods) {
      try {
        stateFor(platform).list = await loadModsGuarded(platform);
      } catch (error) {
        // 容错：mod 扫描异常（权限/损坏）不阻断清单服务——记录并置空
        logger.error("Asset", `mod 列表刷新失败: ${(error as Error).message}`);
        stateFor(platform).list = emptyModsList();
      }
    } else if (config.assets.enableMods && !stateFor(platform).loaded) {
      // 容错：mod 文件请求早于热更清单（客户端缓存清单直连下载）——补齐初始加载
      await ensureModsLoaded(platform);
    }
    const mods = getModsList(platform);

    // odpy 代理模式（downloadPeoxy）：直接转发官服 CDN（支持 Range 断点续传，不落盘）
    if (
      config.assets.downloadPeoxy &&
      fileName !== "hot_update_list.json" &&
      !mods.download.includes(fileName)
    ) {
      const forwardHeaders: Record<string, string> = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/105.0.0.0 Safari/537.36",
      };
      const rangeHeader = req.headers.range as string | undefined;
      if (rangeHeader) forwardHeaders.Range = rangeHeader;
      const resp = await fetch(
        `${resolveCdnBase()}/assetbundle/official/${cdnPlatform}/assets/${cdnVersion}/${fileName}`,
        { headers: forwardHeaders, signal: AbortSignal.timeout(CDN_TIMEOUT) },
      );
      const body = Buffer.from(await resp.arrayBuffer());
      res.status(resp.status);
      resp.headers.forEach((value, key) => {
        if (key.toLowerCase() !== "transfer-encoding") res.setHeader(key, value);
      });
      res.send(body);
      return;
    }

    if (!config.assets.downloadLocally) {
      basePath = join(__dirname, "..", "..", "..", "assets", version);
      if (
        fileName !== "hot_update_list.json" &&
        !mods.download.includes(fileName)
      ) {
        return res.redirect(
          `${resolveCdnBase()}/assetbundle/official/${cdnPlatform}/assets/${version}/${fileName}`,
        );
      }
    }
    if (!(await exists(basePath))) {
      await mkdir(basePath, { recursive: true });
    }

    let filePath = join(basePath, fileName);

    let wrongSize = false;
    if (fileName !== "hot_update_list.json") {
      const tempHotUpdatePath = join(basePath, "hot_update_list.json");
      // 容错：版本目录缺 hot_update_list（客户端直连 .dat 等）时跳过尺寸校验——防 ENOENT 500
      if (await exists(tempHotUpdatePath)) {
        const hotUpdate = JSON.parse(await readFile(tempHotUpdatePath, "utf-8"));
        if (await exists(filePath)) {
          for (const pack of hotUpdate.packInfos) {
            if (pack.name === fileName.split(".")[0]) {
              wrongSize = (await size(filePath)) !== pack.totalSize;
              break;
            }
          }
        }
      }
    }

    if (config.assets.enableMods) {
      // 客户端把清单 name（含子路径 anon/xxx.bin）扁平化为下载名（anon_xxx.dat，/→_、去后缀加.dat）
      // 请求路径即 download 名；个别场景也可能直接请求原始 name（含子路径），两者都兼容。
      // download/name/path 按下标一一对应。
      const idx = mods.download.indexOf(fileName);
      const isModName = idx >= 0 || mods.name.includes(fileName);
      const modPath =
        idx >= 0
          ? mods.path[idx]
          : isModName
            ? mods.path[mods.name.indexOf(fileName)]
            : undefined;
      if (isModName) {
        // 这是 mod 下载请求：文件缺失时显式 404 报错，绝不静默回退官方 CDN——
        // base 资产（如内置 Lua bundle）在 CDN 上必 404，回退只会让客户端误记
        // "下载失败"并拉黑该资源（12:20 客户端曾因缓存路径失效被 404 污染，之后不再重试）。
        if (!modPath || !(await exists(modPath))) {
          logger.warn("Asset", `mod 文件缺失，显式 404: ${fileName}（path=${modPath ?? "无"}）`);
          res.status(404).json({ status: 404, msg: `mod 文件缺失: ${fileName}` });
          return;
        }
        // INFO 级：便于观测客户端是否请求了 mod 下载（真实客户端会话可据此确认）
        logger.info("Asset", "serve mod file", fileName, modPath);
        wrongSize = false;
        filePath = modPath;
        basePath = join(__dirname, "..", "..", "..", "mods");
        fileName = basename(filePath);
      } else {
        // 非 mod 资源：本版本目录缺失时回退「官方版本目录」（assets/{官方版本}/redirect/）。
        // asset-backfill 的预取/补全统一落官方版本目录，mod 签名版本与直连版本共享命中；
        // 仅当官方版本目录与请求目录不同才回退，且不覆盖 wrongSize 校验（文件已存在判定）。
        const canonicalPath = join(
          join(__dirname, "..", "..", "..", "assets", cdnVersion, "redirect"),
          fileName,
        );
        if (
          canonicalPath !== filePath &&
          !(await exists(filePath)) &&
          (await exists(canonicalPath))
        ) {
          filePath = canonicalPath;
        }
      }
    } else if (
      // 未启用 mod 时同样支持官方版本目录回退（预取补全对直连版本生效）
      fileName !== "hot_update_list.json"
    ) {
      const canonicalPath = join(
        join(__dirname, "..", "..", "..", "assets", cdnVersion, "redirect"),
        fileName,
      );
      if (
        canonicalPath !== filePath &&
        !(await exists(filePath)) &&
        (await exists(canonicalPath))
      ) {
        filePath = canonicalPath;
      }
    }
    const fp = await exportFile(
      `${resolveCdnBase()}/assetbundle/official/${cdnPlatform}/assets/${cdnVersion}/${fileName}`,
      basePath,
      fileName,
      filePath,
      assetsHash,
      wrongSize,
      mods,
      cdnPlatform,
    );
    logger.debug("Asset", "serve", fp);
    res.sendFile(fp);
  },
);

interface ModsList {
  /** mod 元数据（mods.<平台>.json 缓存内容；未建模 JSON，取值须显式收窄） */
  mods: JsonValue[];
  name: string[];
  path: string[];
  download: string[];
}

function emptyModsList(): ModsList {
  return { mods: [], name: [], path: [], download: [] };
}

/**
 * 同平台 loadMods 并发去重：hot_update_list.json 请求每次都会触发 loadMods，
 * 缓存 miss（首次/缓存损坏/目录变更）时全量扫描 + 写缓存——多个并发请求各自扫描
 * 并并发写缓存文件会互相覆盖/拼接，产生损坏 JSON（实测 2026-08-18：mods.Windows.json
 * 出现两段 JSON 拼接，"Unexpected non-whitespace character after JSON"）。
 * 同一时间同平台只允许一个 loadMods 在执行，其余复用其 Promise。
 * @param platform - 平台键
 * @returns mod 列表 Promise（并发共享）
 */
const loadingMods: Record<string, Promise<ModsList>> = {};

function loadModsGuarded(platform: string): Promise<ModsList> {
  if (!loadingMods[platform]) {
    loadingMods[platform] = loadMods(platform).finally(() => {
      delete loadingMods[platform];
    });
  }
  return loadingMods[platform];
}

/**
 * mod 缓存文件原子写：先写 .tmp 再 rename（原子替换），并用全局队列串行化——
 * loadMods 每处理完一个 zip 条目就写一次完整缓存，多个 .dat / 多次 loadMods
 * 并发写 writeFile 会互相覆盖/拼接损坏 JSON；串行 + 原子替换保证文件内容始终是
 * 某个完整快照（最后写入者完整覆盖）。
 * @param modCachePath - 缓存文件路径（mods.<平台>.json）
 * @param data         - 序列化后的缓存内容
 */
let cacheWriteChain: Promise<void> = Promise.resolve();
function writeModCacheAtomically(modCachePath: string, data: string): Promise<void> {
  cacheWriteChain = cacheWriteChain.then(async () => {
    const tmpPath = modCachePath + ".tmp";
    await writeFile(tmpPath, data);
    await rename(tmpPath, modCachePath);
  });
  return cacheWriteChain;
}

/** mods 目录（.gitignore；仅 mods/.placeholder 与平台子目录占位入 git） */
const MODS_DIR = join(__dirname, "..", "..", "..", "mods");

/** 平台 → 专属 mod 子目录（小写）；未知平台无专属目录（仅共享根目录） */
const PLATFORM_DIRS: Record<string, string> = { Windows: "windows", Android: "android" };

/** 单平台 mod 状态 */
interface ModsState {
  list: ModsList;
  loaded: boolean;
  fingerprint: string;
}

/** 各平台 mod 状态（懒初始化；未知平台回退 Android） */
const MODS_STATES: Record<string, ModsState> = {};

function stateFor(platform: string): ModsState {
  const key = platform || "Android";
  if (!MODS_STATES[key]) {
    MODS_STATES[key] = { list: emptyModsList(), loaded: false, fingerprint: "" };
  }
  return MODS_STATES[key];
}

/** 某平台加载的 mod 目录：平台专属目录优先，共享根目录回退（既支持平台 mod 也兼容历史根目录 mod） */
function platformModDirs(platform: string): string[] {
  const dirs: string[] = [];
  const sub = PLATFORM_DIRS[platform];
  if (sub) dirs.push(join(MODS_DIR, sub));
  dirs.push(MODS_DIR);
  return dirs;
}

/**
 * 轻量扫描某平台 mod 目录的 .dat 文件指纹（仅 stat，不读内容）。
 * 用于版本端点检测资源变更：避免每次请求全量读 .dat 重算 md5。
 * @param platform - 平台键（Windows/Android）
 * @returns 指纹串（path|mtimeMs|size，按路径排序）；目录不存在/IO 异常跳过对应目录
 */
async function computeModsFingerprint(platform: string): Promise<string> {
  const parts: string[] = [];
  for (const dir of platformModDirs(platform)) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".dat")) continue;
      try {
        const st = await stat(join(dir, f));
        parts.push(`${dir}/${f}:${st.mtimeMs}:${st.size}`);
      } catch {
        parts.push(`${dir}/${f}:missing`);
      }
    }
  }
  parts.sort();
  return parts.join(",");
}

/**
 * 运行时 mod 变更检测：某平台 mod 目录指纹变化时重载其列表。
 * 重打包 Lua 资源（替换/新增 .dat）后，无需重启服务即可让该平台 resVersion 后缀变化，
 * 从而提示客户端重新拉取热更清单并下载新资源。
 * @param platform - 平台键（Windows/Android）
 * @returns 本次是否发生了重载
 */
export async function refreshModsIfChanged(platform: string): Promise<boolean> {
  if (!config.assets.enableMods) return false;
  const state = stateFor(platform);
  const fp = await computeModsFingerprint(platform);
  if (fp === state.fingerprint) return false;
  state.fingerprint = fp;
  try {
    state.list = await loadModsGuarded(platform);
    logger.info(
      "Asset",
      `[${platform}] mod 变更检测到，已重载：${state.list.mods.length} 个`,
    );
  } catch (error) {
    logger.error("Asset", `[${platform}] mod 变更重载失败: ${(error as Error).message}`);
    state.list = emptyModsList();
  }
  return true;
}

/**
 * 加载某平台 mod 列表（启动预热/缺省加载用）。失败不阻塞——记录错误并置空列表。
 * @param platform - 平台键；缺省时预热全部已知平台
 */
export async function initMods(platform?: string): Promise<void> {
  const keys = platform ? [platform] : Object.keys(PLATFORM_DIRS);
  for (const p of keys) {
    const state = stateFor(p);
    if (state.loaded) continue;
    state.loaded = true;
    try {
      state.list = await loadModsGuarded(p);
      // 同步指纹基线，避免启动后首个版本请求触发一次无意义的重复重载
      state.fingerprint = await computeModsFingerprint(p);
      logger.info(
        "Asset",
        `[${p}] mod 加载完成：${state.list.mods.length} 个（enableMods=${config.assets.enableMods}）`,
      );
    } catch (error) {
      logger.error("Asset", `[${p}] mod 加载失败: ${(error as Error).message}`);
      state.list = emptyModsList();
    }
  }
}

export function getModsList(platform: string): ModsList {
  return stateFor(platform).list;
}

export async function ensureModsLoaded(platform: string): Promise<void> {
  const state = stateFor(platform);
  if (!state.loaded) await initMods(platform);
}

/**
 * 计算 mod 条目的起始 cid：官方 cid 是 abInfos(1..N) 与 packInfos(N+1..) 共用的
 * 全局唯一序号，mod 必须从两者最大值之后续起——否则与 pack 撞号会让客户端按 code
 * 管理下载任务时出现"大小不一致"（实测 14982/14983 撞 lpack_init1/2 致更新中止）。
 * @param abInfos   - 官方 abInfos（含 cid）
 * @param packInfos - 官方 packInfos（含 cid，可缺省）
 * @returns mod 起始 cid
 */
export function nextModBaseCid(abInfos: { cid?: number }[], packInfos: { cid?: number }[]): number {
  return [...abInfos, ...packInfos].reduce((max, a) => Math.max(max, a.cid ?? 0), 0) + 1;
}

/**
 * 确定性 resVersion 变更签名：mod 集合不变 → 签名不变（客户端不重复全量重下）；
 * mod 变更 → 签名变化（触发热更清单重新拉取）。无 mod 时返回 ""（保持原版行为）。
 *
 * 返回 6 位 hex 签名（对齐官方 hash 格式）。调用方用它**替换** resVersion 的 hash 部分
 * （见 app/core/config/prod.ts：`resVersion.slice(0, 18) + sig`），保持官方
 * `YYYY-MM-DD-HH-MM-SS_<6位hash>` 格式——追加 `-m` 后缀会破坏客户端 versionId 解析，
 * 导致客户端静默跳过整个热更流程（mod 永不下载）。
 * @param platform - 平台键（Windows/Android），签名按平台独立计算
 */
export function getModVersionSuffix(platform: string): string {
  const list = stateFor(platform).list;
  if (list.mods.length === 0) return "";
  // 签名含内容指纹（md5）：插件/内置 bundle 内容变更必然改变 md5 → 签名变化 → 客户端重新拉取热更清单并下载。
  // 仅用 name|totalSize 时，repack 后 totalSize 未必变（zip 压缩后尺寸巧合相等），客户端会因版本未变而误用本地缓存旧 bundle。
  const sig = list.mods
    .map((m) => `${(m as { name: string }).name}|${(m as { md5: string }).md5}`)
    .sort()
    .join(",");
  return createHash("md5").update(sig).digest("hex").slice(0, 6);
}

/**
 * 官方（无 mod 签名）资源版本：按平台取 config 中登记的官方 resVersion（CDN 下载用）。
 * 客户端请求的 assetsHash 是替换过 hash 的 mod 版本，需还原官方版本才能命中官方 CDN。
 * region 生效时：region.cdnVersion 显式指定则用之（「指定资源版本」），否则用伪装后的
 * region.version.resVersion（version 端点下发的值），最后回退 config.version 现状。
 * @param platform - 平台键（Windows/Android），未知平台回退默认版本
 */
export function officialResVersion(platform: string): string {
  const region = resolveRegion();
  const version = region ? resolveRegionVersion(region, config.version) : config.version;
  const win = version.windows;
  if (platform === "Windows" && win?.resVersion) return win.resVersion;
  return region ? resolveRegionCdnVersion(region, version) : version.resVersion;
}

/**
 * 资源 CDN 基址：region.cdn 可配（缺省国服 CDN）——downloadPeoxy 代理转发、
 * downloadLocally=false 重定向与 exportFile 下载共用。
 */
function resolveCdnBase(): string {
  return resolveRegionCdn(resolveRegion());
}

/**
 * 去除资源版本号的 mod 后缀（`-m{6位hex}`，历史格式）。
 * @deprecated 新格式为「替换 hash 部分」（见 getModVersionSuffix / officialResVersion），
 * CDN 下载改用 officialResVersion(platform) 还原官方版本；本函数仅保留兼容旧调用。
 */
export function stripModSuffix(version: string): string {
  return version.replace(/-m[0-9a-fA-F]{6}$/, "");
}

const downloadingFiles: { [key: string]: EventEmitter } = {};

/** CDN 下载超时（毫秒）——官服 CDN 不可达时快速失败（5xx），避免客户端请求挂起致界面卡死 */
const CDN_TIMEOUT = 10000;

async function downloadFile(url: string, filePath: string): Promise<void> {
  logger.info("Asset", `Download ${filePath.split("/").pop()}`);
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: CDN_TIMEOUT,
  });
  await writeFile(filePath, response.data);
  // 溯源：CDN 文件获取留痕（fire-and-forget，不阻断下载热路径）
  void assetRegistry
    .recordEvent({
      asset: {
        name: basename(filePath),
        category: "file",
        source: url,
        version: officialResVersion("Android"),
        hash: createHash("md5").update(response.data).digest("hex"),
        size: response.data.length,
      },
      action: "acquire",
      actor: "asset-router",
      source: url,
      hashAfter: createHash("md5").update(response.data).digest("hex"),
      sizeAfter: response.data.length,
    })
    .catch(() => undefined);
}

async function exportFile(
  url: string,
  basePath: string,
  fileName: string,
  filePath: string,
  assetsHash: string,
  reDownload = false,
  mods?: ModsList,
  backfillPlatform?: string,
): Promise<string> {
  if (basename(filePath) === "hot_update_list.json") {
    let hotUpdateList;
    if (await exists(filePath)) {
      hotUpdateList = JSON.parse(await readFile(filePath, "utf-8"));
    } else {
      const response = await axios.get(url, { timeout: CDN_TIMEOUT });
      hotUpdateList = response.data;
      await writeFile(filePath, JSON.stringify(hotUpdateList));
    }

    const abInfoList = hotUpdateList.abInfos;
    const newAbInfos = [];

    for (const abInfo of abInfoList) {
      if (config.assets.enableMods) {
        hotUpdateList.versionId = assetsHash;
        if (abInfo.hash.length === 24) {
          abInfo.hash = assetsHash;
        }
        if (!mods!.name.includes(abInfo.name)) {
          newAbInfos.push(abInfo);
        }
      } else {
        newAbInfos.push(abInfo);
      }
    }

    if (config.assets.enableMods) {
      // 官方 cid 是 abInfos(1..N) 与 packInfos(N+1..) 共用的全局唯一序号；
      // mod 条目必须从两者最大值之后续起——否则与 pack 撞号会让客户端
      // 按 code 管理下载任务时出现"大小不一致"（实测：mod 分配 14982/14983
      // 撞上 lpack_init1/2 的 14982/14983，导致整个更新中止）。
      const baseCid = nextModBaseCid(
        abInfoList as { cid?: number }[],
        (hotUpdateList.packInfos ?? []) as { cid?: number }[],
      );
      for (let i = 0; i < mods!.mods.length; i++) {
        const mod = mods!.mods[i];
        newAbInfos.push({ ...(isJsonObject(mod) ? mod : {}), cid: baseCid + i });
      }
    }

    hotUpdateList.abInfos = newAbInfos;

    const cachePath = join(__dirname, "..", "..", "..", "./assets/cache/");
    const savePath = join(cachePath, "hot_update_list.json");
    logger.debug("Asset", "cache path", cachePath);
    if (!(await exists(cachePath))) {
      await mkdir(cachePath, { recursive: true });
    }
    await writeFile(savePath, JSON.stringify(hotUpdateList));

    // 溯源：清单交付 + mod 注入留痕（fire-and-forget）
    const manifestHash = createHash("md5")
      .update(JSON.stringify(hotUpdateList))
      .digest("hex");
    void assetRegistry
      .recordEvent({
        asset: {
          name: "hot_update_list.json",
          category: "manifest",
          source: url,
          version: hotUpdateList.versionId ?? assetsHash,
          hash: manifestHash,
          size: Buffer.byteLength(JSON.stringify(hotUpdateList)),
        },
        action: "deliver",
        actor: "asset-router",
        source: url,
        version: assetsHash,
        detail: { abInfos: newAbInfos.length },
      })
      .catch(() => undefined);
    if (config.assets.enableMods) {
      const injectedMods = (mods?.mods ?? []).map((m) => (m as { name?: string }).name);
      void assetRegistry
        .recordEvent({
          asset: {
            name: "hot_update_list.json",
            category: "manifest",
            source: url,
            version: hotUpdateList.versionId ?? assetsHash,
            hash: manifestHash,
            size: Buffer.byteLength(JSON.stringify(hotUpdateList)),
          },
          action: "modify",
          actor: "asset-router",
          source: "mod 注入",
          version: assetsHash,
          detail: { injectedMods },
        })
        .catch(() => undefined);
    }

    return join(__dirname, "..", "..", "../assets/cache/hot_update_list.json");
  }

  let downloadingThread = null;
  if (
    !downloadingFiles[filePath] &&
    (!(await exists(filePath)) || reDownload)
  ) {
    downloadingFiles[filePath] = new EventEmitter();
    downloadingThread = (async () => {
      await downloadFile(url, filePath);
      downloadingFiles[filePath].emit("downloaded");
    })();
  }

  try {
    if (downloadingThread) {
      await downloadingThread;
      delete downloadingFiles[filePath];
    } else {
      if (downloadingFiles[filePath]) {
        await new Promise((resolve) =>
          downloadingFiles[filePath].once("downloaded", resolve),
        );
      }
    }
  } catch (err) {
    // 自动补全：当前版本 CDN 缺失（404/网络失败）→ asset-backfill 本地其它版本拷贝 /
    // 官方 CDN 历史版本探测下载，统一落官方版本目录（mod 签名版本与直连版本共享命中）。
    // 仅对常规资源生效（hot_update_list 已提前 return；mod 文件走 modPath 不进入此路径）。
    const platform = backfillPlatform ?? "Android";
    const canonicalPath = join(
      join(__dirname, "..", "..", "..", "assets", officialResVersion(platform), "redirect"),
      fileName,
    );
    if (await backfillFile(platform, fileName, canonicalPath)) {
      logger.info("Asset", `自动补全 ${fileName} → ${canonicalPath}`);
      return canonicalPath;
    }
    // 补全失败保持原错误行为（调用方/客户端可见 4xx-5xx）
    throw err;
  }

  // 返回真实文件路径（而非 join(basePath, fileName)）：
  // 常规资源 filePath 本就是 basePath/fileName，等价；但平台专属 mod
  // （mods/windows|android/xxx.dat）的 filePath 在子目录，若按 basePath(硬编码 mods/)
  // + basename 拼接会得到不存在的路径 → sendFile ENOENT → 客户端 404
  // （实测：皮肤包 mod 在 mods/windows/ 下被 404，而根目录的 anon mod 正常）。
  return filePath;
}

async function loadMods(platform: string): Promise<ModsList> {
  const loadedModList: ModsList = emptyModsList();

  // 收集所有 .dat：平台专属目录在前（平台 mod 优先去重），共享根目录在后（回退）
  const fileList: string[] = [];
  for (const dir of platformModDirs(platform)) {
    let dirEntries: string[];
    try {
      dirEntries = await readdir(dir);
    } catch (error) {
      // 容错：目录不存在（未创建/未启用）跳过——避免 readdir ENOENT 使清单请求 500
      logger.warn(
        "Asset",
        `mods 目录不存在（${dir}），跳过: ${(error as Error).message}`,
      );
      continue;
    }
    for (const file of dirEntries) {
      if (file !== ".placeholder" && file.endsWith(".dat")) {
        fileList.push(join(dir, file));
      }
    }
  }
  if (fileList.length === 0) return loadedModList;

  const datFileInfos: { [key: string]: { size: number; crc32: number } } = {};

  for (const filePath of fileList) {
    // 容错：单个 .dat 读取失败（权限/占用）跳过，不阻断整体加载
    try {
      const fileContent = await readFile(filePath);
      const fileSize = fileContent.length;
      const fileCrc32 = crc32(fileContent);
      datFileInfos[filePath] = {
        size: fileSize,
        crc32: fileCrc32,
      };
    } catch (error) {
      logger.warn(
        "Asset",
        `${basename(filePath)} 读取失败，跳过: ${(error as Error).message}`,
      );
    }
  }

  // 平台隔离缓存文件（避免 Windows/Android 互踩覆盖）
  const modCachePath = join(__dirname, "..", "..", "..", `mods.${platform}.json`);
  let modCache = null;

  if (await exists(modCachePath)) {
    modCache = JSON.parse(await readFile(modCachePath, "utf-8"));
  }

  let modCacheValid = false;

  if (modCache) {
    const cachedDatFileInfos = modCache.file;
    // 指纹比对：键为绝对路径（含平台子目录）——旧缓存（异地/旧项目路径/旧单一结构）键不匹配 → 自动判失效重建
    if (JSON.stringify(datFileInfos) === JSON.stringify(cachedDatFileInfos)) {
      modCacheValid = true;
    }
  }

  if (modCacheValid && modCache) {
    const cached = modCache.mod;
    loadedModList.mods = cached.mods;
    loadedModList.name = cached.name;
    // 缓存 path 相对 MODS_DIR（如 windows/foo.dat 或 foo.dat）→ 还原绝对路径
    loadedModList.path = (cached.path as string[]).map((p) => join(MODS_DIR, p));
    loadedModList.download = cached.download;
    logger.info("Asset", `[${platform}] ${fileList[0] ?? "mods"} - Using Cached Mod...`);
    return loadedModList;
  }

  const seenDownloads = new Set<string>();
  for (const filePath of fileList) {
    if ((await size(filePath)) === 0) {
      continue;
    }
    let modFile: yauzl.ZipFile;
    try {
      modFile = await openZipFile(filePath);
    } catch (error) {
      // 容错：损坏/非 zip 的 .dat 跳过（不再 throw 炸进程）
      logger.warn(
        "Asset",
        `${basename(filePath)} - mod 解析失败，跳过: ${(error as Error).message}`,
      );
      continue;
    }
    modFile.readEntry();
    modFile.on("entry", (entry) => {
      if (!/\/$/.test(entry.fileName)) {
        const modName = entry.fileName;
        if (loadedModList.name.includes(modName)) {
          logger.warn(
            "Asset",
            `${filePath} - Conflict with other mods...`,
          );
          modFile.readEntry();
          return;
        }
        const downloadName =
          modName.replace(/\//g, "_").replace(/#/g, "__").split(".")[0] +
          ".dat";
        if (seenDownloads.has(downloadName)) {
          logger.warn(
            "Asset",
            `${filePath} - ${modName} 与其它 mod 映射到同一下载名 ${downloadName}，跳过`,
          );
          modFile.readEntry();
          return;
        }
        seenDownloads.add(downloadName);
        modFile.openReadStream(entry, (err, readStream) => {
          if (err) {
            logger.warn(
              "Asset",
              `${filePath} - 读取条目失败: ${err.message}`,
            );
            modFile.readEntry();
            return;
          }
          const chunks: Buffer[] = [];
          readStream!.on("data", (chunk) => chunks.push(chunk));
          readStream!.on("error", (streamErr) => {
            logger.warn(
              "Asset",
              `${filePath} - 读取条目出错，跳过: ${streamErr.message}`,
            );
            modFile.readEntry();
          });
          readStream!.on("end", async () => {
            const byteBuffer = Buffer.concat(chunks);
            // 官方语义：totalSize = 可下载的 .dat(zip) 实际大小（客户端按此判定下载完成），
            // abSize = 解压后 bundle 大小（客户端一致性校验 fileInfo.Length==abSize）。
            // 曾错把两者都设成 bundle 大小 → 客户端按更大的 totalSize 等待下载，实际收不到 → "下载失败"
            const totalSize = datFileInfos[filePath]?.size ?? byteBuffer.length;
            const abSize = byteBuffer.length;
            const modMd5 = createHash("md5").update(byteBuffer).digest("hex");

            const abInfo = {
              name: modName,
              hash: modMd5,
              md5: modMd5,
              totalSize: totalSize,
              abSize: abSize,
            };

            logger.info(
              "Asset",
              `${filePath} - Mod loaded successfully...`,
            );

            loadedModList.mods.push(abInfo);
            loadedModList.name.push(modName);
            // 运行时 path 为绝对路径；落盘缓存转存相对 MODS_DIR 的路径（含平台子目录，可移植）。
            // 注意：此处 relative 结果已是相对 MODS_DIR 的路径，落盘时不可再 relative——
            // 二次 relative 会把相对路径当相对 cwd 解析，生成错误的 `..\` 前缀（bug 修复）。
            loadedModList.path.push(relative(MODS_DIR, filePath));
            loadedModList.download.push(downloadName);
            await writeModCacheAtomically(
              modCachePath,
              JSON.stringify(
                {
                  file: datFileInfos,
                  mod: {
                    mods: loadedModList.mods,
                    name: loadedModList.name,
                    path: loadedModList.path, // 已是相对 MODS_DIR 的路径，直接落盘
                    download: loadedModList.download,
                  },
                },
                null,
                4,
              ),
            );
            modFile.readEntry();
          });
        });
      } else {
        modFile.readEntry();
      }
    });
  }

  return loadedModList;
}

function openZipFile(filePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (err, zipFile) => {
      if (err) reject(err);
      else resolve(zipFile);
    });
  });
}

export default router;
