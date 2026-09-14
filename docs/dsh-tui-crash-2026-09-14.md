# dsh-tui 意外崩溃：排查与规避（2026-09-14）

本文记录「TUI（`dsh-tui`）在长会话中意外崩溃」的现场证据、最可能的成因，以及已经落地到仓库的**输出闸门**与后续操作纪律。

## 1. 现场证据

### 1.1 内核日志：node 进程成批以 `SIGILL` 中止

```
traps: node[13493] trap invalid opcode ip:742777c3e5c5 sp:74276b7fc080 error:0 in libnode.so.127[203e5c5,742776899000+2bb0000]
node: node: potentially unexpected fatal signal 4.
```

- 失败指令偏移固定为 `libnode.so.127+0x203e5c5`；该处机器码为 `… 75 03 cc 0f 0b …`，其中 **`0f 0b` = `ud2`**——这不是随机非法指令，而是 **V8 主动中止**（`FATAL`/`OOM`/`CHECK` 失败路径）。
- 中止**成批发生**（同一瞬间 3 个 node 进程一起死；实测多个时间点各 3 个：uptime 87349 / 87563 / 88245 / 101566 / 103488）。
- 时间线上紧跟在 WSL 客户机的内存回收之后：`mini_init (275): drop_caches: 1`（每 90–150s 一次）。
- 同期出现过 `Tainted: [W]=WARN`、以及负载飙到 **32**（`uptime`），而**没有** `oom-kill` 记录。

### 1.2 内存相关的量化事实

| 项 | 实测值 |
| --- | --- |
| WSL 客户机内存 | 15.8 GB（swap 4 GB） |
| cgroup 内存上限 | **无**（`/sys/fs/cgroup/memory.max` 不存在；进程在 `user@0.service/app.slice/dsh-subprocess-*.scope`） |
| 每进程 V8 堆上限 | 4,144 MB（`v8.getHeapStatistics().heap_size_limit`） |
| 崩溃前宿主（Windows）内存 | 32 GB 总量 / 12.8 GB 空闲 |

⇒ 4 个 node 进程各自允许长到 ~4 GB，理论峰值就超过客户机 15.8 GB；一旦同时增长，客户机进入回收/压力状态，V8 的分配失败路径即 `ud2` 中止——**TUI 也是 node 进程，会被一起带走**（这解释了「TUI 意外崩溃」以及工具调用被打断：本会话就出现过两次 `tool call was interrupted`）。

### 1.3 最大的可控放大器：工具输出

TUI 会把会话内容（含**工具输出**）留在内存里。本次调试期间出现过单条 **14.9 MB** 的日志输出（frida 宿主日志洪水）、3–11 MB 的 `*.txt` 抓取、以及一次 `strings` 的巨量回显。这些都会进 TUI 的堆：**输出越大，TUI 越接近 V8 中止**。

## 2. 已落地的修复（仓库内，可验证）

| # | 位置 | 措施 | 验证 |
| --- | --- | --- | --- |
| 1 | `scripts/frida-mumu-arm64.py` | 新增输出闸门：`emit()` 统一出口，**累计 2 MB 上限**（`--max-output-bytes`，`0`=不限）+ **单行 2000 字符**上限 + 超限只报一次截断提示 | 单测三例：累计超限在第 172 B 停下且只提示 1 次；5000 字符单行被截到 2008 B；`0` 模式不截断 ✓ |
| 2 | `hook/host-logs.js` | 单条日志 **400 字符截断**（`clip()`），叠加既有的标签黑名单（`houdini`）与 `MAX_SEND=4000` 上限 | `node -e new Function(...)` 语法通过；下一轮 frida 实测生效 |
| 3 | `hook/host-logs.js`（上一轮） | 丢掉 houdini 转译层噪声：**单轮 27.5 万行/14.9 MB → 69 行/4.4 KB**（-99.96%） | 实测对比 |
| 4 | 运行方式 | 私服改成 `run_in_background` + **stdout 重定向到文件**（`NODE_OPTIONS=--max-old-space-size=2048`），不让 job 缓冲区吞日志 | 服务日志稳定在 KB 级 |

管线改动后的真实回归：`--max-output-bytes 300000` 跑一轮，全程输出 **2,284 字节**、gadget 注入与双 agent 钩子正常、退出码 0 ✓。

## 3. 操作纪律（后续长会话照做）

1. **有界读取**：设备/管线日志一律 `> tmp/xxx.log` 落盘，再用 `tail -c 4000`、`grep -c`、`head -n` 查看；**禁止 `cat` 大文件**、禁止 `strings` 大二进制直出。
2. **控制并发 node 数**：客户机里同时只保留必要的长驻 node（私服 1 个）；vitest/frida 管线错开跑，避免 4×4 GB 的堆上限叠加。
3. **长调试换新会话**：TUI 的内存随会话单调增长，超过数小时后建议新开 DSH 会话（本会话已极长，是 TUI 崩溃的高风险场景）。
4. **给 WSL 明确上限**（可选，用户侧）：在 `C:\Users\<你>\.wslconfig` 写
   ```ini
   [wsl2]
   memory=24GB
   swap=8GB
   ```
   避免客户机在宿主内存紧张时反复 `drop_caches`。
5. **崩溃后再看现场**：`dmesg | grep -aE "traps:|fatal signal"`（确认是否仍是 `libnode.so …0x203e5c5` 的 `ud2`）；`free -m`、`uptime` 看内存与负载。

## 4. 磁盘回收（可选，未擅自删除）

`tmp/` 共约 9.6 GB，其中大件都是既有产物（本次未动）：`tmp/decompile` 4.1 GB、`tmp/apk-out` 2.1 GB（重签名 APK）、`tmp/apk` 1.8 GB（官方 APK 副本）、`tmp/ark7z` 474 MB、`tmp/obs_ref` 414 MB。磁盘尚有 556 GB 空闲，不构成崩溃因素，需要腾空间时按上表自取。

## 5. 结论

- **崩溃本体**是 V8 的 `ud2` 主动中止（非内核 OOM、非磁盘），发生在客户机内存回收/高负载窗口，**TUI 与调试用的 node 进程同批被杀**。
- **可修复的部分**是"我们喂给 TUI 的数据量"与"并发 node 数"：本轮已把管线输出硬闸门化（2 MB / 2000 字符 / 单条 400 字符）并做了单测与实跑验证；理论上把 TUI 堆增长的主要来源掐掉。
- 若仍复现，请按下节留下现场：`dmesg` 的 `traps` 行 + 当时 `free -m`/`uptime` + 崩溃前最后一条工具输出大小——三者可判定是"同一 `ud2` 家族"还是新原因。
