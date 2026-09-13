/**
 * 随机数工具模块
 *
 * 提供常用的随机数生成和随机选择功能，用于抽卡、招募等游戏随机机制。
 *
 * 2026-09-13：并入原 `app/game/kernel/util/random.ts` 的**可注入随机源**
 * （`random` / `setRandSource` / `resetRandSource`）——零依赖纯工具、被 29 处
 * 跨模块消费，下沉 core 后 game/ops/scripts 统一从 `@utils/random` 取用。
 * 既有 `randomInt` / `randomChoices` / `randomSample` / `randomChoice` / `divmod`
 * 保持直连 `Math.random` 的历史行为不变（勿改为经注入源，避免行为漂移）。
 */
import { randomUUID } from "node:crypto";

/**
 * 生成战斗唯一标识（battleId）
 *
 * 使用 crypto.randomUUID（v4）生成全局唯一的随机标识，替代此前 `时间戳_随机数`
 * 或固定值 `"1"` 的 battleId——随机性由系统加密级 PRNG 保证，多场战斗不冲突，
 * 兼顾并发与后续按 uuid 检索的历史分析需求。
 *
 * @returns 形如 `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx` 的小写 UUID 字符串
 */
export function generateBattleId(): string {
  return randomUUID();
}

/**
 * 生成指定范围内的随机整数
 * 
 * @param min - 最小值（包含）
 * @param max - 最大值（包含）
 * @returns 随机整数
 */
export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * 加权随机选择
 * 
 * 根据权重数组从数组中随机选择 k 个元素，权重越高被选中的概率越大。
 * 
 * @param arr - 待选择的数组
 * @param weights - 对应的权重数组
 * @param k - 选择的数量
 * @returns 选中的元素数组
 */
export function randomChoices<T>(arr: T[], weights: number[], k: number): T[] {
  const result: T[] = [];
  for (let i = 0; i < k; i++) {
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let random = Math.random() * totalWeight;
    for (let j = 0; j < arr.length; j++) {
      random -= weights[j];
      if (random <= 0) {
        result.push(arr[j]);
        break;
      }
    }
  }
  return result;
}

/**
 * 无放回随机抽样
 * 
 * 随机打乱数组并取前 k 个元素。
 * 
 * @param arr - 待抽样的数组
 * @param k - 抽样数量
 * @returns 抽样结果数组
 */
export function randomSample<T>(arr: T[], k: number): T[] {
  return arr.sort(() => 0.5 - Math.random()).slice(0, k);
}

/**
 * 随机选择一个元素
 * 
 * @param arr - 待选择的数组
 * @returns 随机选中的元素
 */
export function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * 整除和取模运算
 * 
 * 返回一个包含商和余数的元组。
 * 
 * @param x - 被除数
 * @param y - 除数
 * @returns [商, 余数]
 */
export function divmod(x: number, y: number): [number, number] {
  return [Math.floor(x / y), x % y];
}

/**
 * 可注入随机源（建议 15：全域随机源注入化）
 *
 * 业务纯函数/引擎统一经 `random()` 取随机数（默认 Math.random）；
 * 测试可经 `setRandSource` 注入固定序列/固定值，实现确定性复现，
 * 消除概率性断言 flaky（如 gacha-rank 的 2% 权重波动）。
 *
 * 约定：
 * - 业务代码只 import { random }，不直接调 Math.random；
 * - 默认源为动态读取 Math.random（兼容既有测试 vi.spyOn(Math, "random")）；
 * - 测试可经 setRandSource 注入固定序列（推荐），结束时 resetRandSource；
 * - 纯函数级 rand 参数注入（如 resolveGachaRank）优先于模块级注入。
 */
let source: () => number = () => Math.random();

/**
 * 注入随机源（测试用）
 * @param fn - 返回 [0,1) 均匀随机数的函数
 */
export function setRandSource(fn: () => number): void {
  source = fn;
}

/** 恢复默认（动态读取 Math.random） */
export function resetRandSource(): void {
  source = () => Math.random();
}

/**
 * 取 [0,1) 随机数（经当前注入源）
 * @returns 当前随机源产出的 [0,1) 随机数
 */
export function random(): number {
  return source();
}