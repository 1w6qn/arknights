/*
 * Frida 17 兼容垫片。
 *
 * 1) frida-il2cpp-bridge 0.9.1 仍在调用 Frida 16 的静态 Module API
 *    （findExportByName / getExportByName / findBaseAddress / getBaseAddress / enumerateExports），
 *    这些在 Frida 17 被移除，导致 "TypeError: not a function"。
 * 2) MuMu(Houdini) 下模块注册表会漏 ARM64 库（libil2cpp.so 在 maps 里却枚举不到），
 *    这里把「合成模块」挂进查找路径。
 */
import { installSyntheticModules } from "./synth-module";

type LegacyModuleStatics = {
  findExportByName?: (moduleName: string | null, exportName: string) => NativePointer | null;
  getExportByName?: (moduleName: string | null, exportName: string) => NativePointer;
  findBaseAddress?: (name: string) => NativePointer | null;
  getBaseAddress?: (name: string) => NativePointer;
  enumerateExports?: (name: string) => ModuleExportDetails[];
};

const legacy = Module as LegacyModuleStatics;

if (typeof legacy.findExportByName !== "function") {
  legacy.findExportByName = (moduleName, exportName) => {
    if (moduleName === null || moduleName === undefined) {
      return Module.findGlobalExportByName(exportName);
    }
    const mod = Process.findModuleByName(moduleName);
    return mod === null ? null : mod.findExportByName(exportName);
  };
}

if (typeof legacy.getExportByName !== "function") {
  legacy.getExportByName = (moduleName, exportName) => {
    const found = legacy.findExportByName === undefined ? null : legacy.findExportByName(moduleName, exportName);
    if (found === null) throw new Error("Unable to find export '" + exportName + "' in " + String(moduleName));
    return found;
  };
}

if (typeof legacy.findBaseAddress !== "function") {
  legacy.findBaseAddress = (name) => {
    const mod = Process.findModuleByName(name);
    return mod === null ? null : mod.base;
  };
}

if (typeof legacy.getBaseAddress !== "function") {
  legacy.getBaseAddress = (name) => Process.getModuleByName(name).base;
}

if (typeof legacy.enumerateExports !== "function") {
  legacy.enumerateExports = (name) => Process.getModuleByName(name).enumerateExports();
}

installSyntheticModules();

export {};
