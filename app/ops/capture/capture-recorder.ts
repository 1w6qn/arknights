/**
 * 抓包写入端口（CaptureRecorder）—— **ops 侧兼容垫片**
 *
 * 2026-09-13：端口契约已下沉 `@core/capture/port`——`app/core/utils/traffic-recorder.ts`
 * 需要它，而 core 不得依赖 ops（R1，见 tests/unit/architecture/module-boundary.test.ts）。
 * 本文件保留原 `@capture/capture-recorder` import 路径供存量引用点使用（零改动），
 * 内容全部 re-export；**新增代码请直接 import `@core/capture/port`**。
 *
 * 实现侧：`app/ops/capture/capture-manager.ts` 的 `captureManager` 天然结构性满足该端口
 * （addRecord 返回更完整的 CaptureRecord，协变兼容），由组合根 `app/server.ts` 注入。
 */
export type {
  BodyKind,
  CaptureBodiesInputPort,
  CaptureBodyInputPort,
  CaptureDirection,
  CaptureHeaders,
  CaptureRecordInputPort,
  CaptureRecordRef,
  CaptureRecorder,
  CaptureSource,
} from "@core/capture/port";
