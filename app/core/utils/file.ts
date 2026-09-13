/**
 * 文件操作工具模块
 * 
 * 提供文件存在性检查、大小获取、JSON 文件读写等常用文件操作功能。
 */

import { access, readFile, stat, writeFile } from "fs/promises";
import { readFileSync } from "fs";
import type { JsonValue } from "./json-value";

/**
 * 检查文件是否存在
 * 
 * @param filePath - 文件路径
 * @returns 文件存在返回 true，否则返回 false
 */
export async function exists(filePath: string): Promise<boolean> {
  return access(filePath)
    .then(() => true)
    .catch(() => false);
}

/**
 * 获取文件大小
 * 
 * @param filePath - 文件路径
 * @returns 文件大小（字节数）
 */
export async function size(filePath: string): Promise<number> {
  return stat(filePath).then((stats) => stats.size);
}

/**
 * 异步读取 JSON 文件
 * 
 * @param filePath - JSON 文件路径
 * @returns 解析后的 JSON 对象
 */
export async function readJson<T = JsonValue>(filePath: string): Promise<T> {
  const data = await readFile(filePath, "utf-8");
  return JSON.parse(data) as T;
}

/**
 * 同步读取 JSON 文件
 * 
 * @param filePath - JSON 文件路径
 * @returns 解析后的 JSON 对象
 */
export function readJsonSync<T = JsonValue>(filePath: string): T {
  const data = readFileSync(filePath, "utf-8");
  return JSON.parse(data) as T;
}

/**
 * 写入 JSON 文件
 * 
 * 将对象序列化为 JSON 字符串并写入文件，格式化缩进为 4 个空格。
 * 
 * @param filePath - 目标文件路径
 * @param data - 要写入的对象
 */
export async function writeJson<T>(filePath: string, data: T): Promise<void> {
  await writeFile(filePath, JSON.stringify(data, null, 4), "utf-8");
}