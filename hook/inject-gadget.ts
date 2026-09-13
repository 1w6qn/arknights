import Java from "frida-java-bridge";

/*
 * 把 ARM64 的 frida-gadget 装进当前进程（官方包、不改 APK、不重签名）。
 *
 * 为什么不能让 System.load 直接干：它内部靠 VMStack 取调用者类，从原生线程调用会拿到 null → NPE。
 * 所以直接调私有 Runtime.load0(Class, String)，显式传应用自己的 Class：
 *   fromClass.getClassLoader() = PathClassLoader → ART 用应用的 linker namespace 装载，
 *   再经 NativeBridge(NativeBridgeItf.loadLibrary) → Houdini 把 ARM64 ELF 映射进来，
 *   gadget 的构造函数在翻译层里跑起来，开始监听。
 */
const GADGET = "/data/app-lib/Yxmrfz2/libfrida-gadget.so";

Java.perform(() => {
  try {
    const app = Java.use("android.app.ActivityThread").currentApplication();
    if (app === null) {
      send({ t: "inject", ok: false, err: "currentApplication() 为 null" });
      return;
    }
    const loader = app.getClassLoader();
    if (loader !== null) Java.classFactory.loader = loader;
    Java.use("java.lang.Runtime").getRuntime().load0(app.getClass(), GADGET);
    send({ t: "inject", ok: true, caller: app.getClass().getName(), loader: loader === null ? null : loader.getClass().getName() });
  } catch (e) {
    send({ t: "inject", ok: false, err: String(e) });
  }
});
