---
name: arknights-lua-asset-signing
description: 明日方舟 Lua 资产（CRYPTIC_A + 128B RSA 签名头）的格式、验签根因与重签名交付流程；用于"重加密的 Lua 被客户端拒绝"、重打包/下发 mod bundle、或替换客户端公钥。
---

# Lua 资产：加密、签名与重签名交付

## 何时用
要改/重打包 Lua 资产（注入代码、改 `DefinedFix`、换版本），或排查"我们改过的 Lua 资产被客户端拒绝/客户端 abort"。

## 格式（官方 2.7.71 实测）
```
TextAsset.m_Script = [128B RSA-1024 签名][16B IV^mask][AES-128-CBC(PKCS7) 密文]
  签名 = RSA-1024 / PKCS#1 v1.5 / MD5( script[128:] )    ← 覆盖 IV 域 + 密文
  key  = UTF8(mask[0:16])      iv = script[128:144] XOR UTF8(mask[16:32])
  mask = "UITpAi82pHAWwnzqHRMCwPonJLIB3WCl"  (= excel MASK_V2 / PlayerData.chatMask)
```
客户端每次加载 Lua 资产都用 `GlobalOptions.cryptoPubKey` 走
`CryptUtils.VerifySignMD5RSA(byte[] contentBytes, byte[] sign, string publicKey)`（RVA `0x042FD3F0`）验签；
**验签失败不是返回 null，而是抛 `Torappu.SecurityException` → 进程终止**。

## 判据（可复跑，不需要设备）
```bash
node node_modules/tsx/dist/cli.mjs tmp/verify-official-key.ts    # 公钥端序/摘要方案校准
node node_modules/tsx/dist/cli.mjs tmp/analyze-lua-roundtrip.ts  # 同 IV 重加密是否逐字节复现官方密文
node node_modules/tsx/dist/cli.mjs tmp/analyze-lua-signature.ts  # 128B 头是否 PKCS#1 签名 + 摘要比对
node node_modules/tsx/dist/cli.mjs tmp/prove-lua-resign.ts       # 重签名后按客户端契约验签
```
结论（344 个资产）：官方公钥必须按**大端**读（指数 17）；同 IV 重加密可逐字节复现官方密文；
每个头都是 `MD5(script[128:])` 的 PKCS#1 签名；用我们私钥重签名后 @我们的公钥 **344/344 通过**。

## 重签名交付流程
```bash
# 1) 注入 + 全 bundle 重签名（长度不变 ⇒ SF 结构零改动）
node node_modules/tsx/dist/cli.mjs scripts/inject-lua-inplace.ts \
  --bundle tmp/official-lua.bin --bundle-name anon/<hash>.bin \
  --asset AVGStickerAutoClickHotfixer --bootstrap fetch --resign-all --out tmp/mod
# 2) 全量验签自检
node node_modules/tsx/dist/cli.mjs tmp/verify-resigned-mod.ts tmp/mod/anon_<hash>.dat
# 3) 落地：把 UnityFS 写入客户端缓存 <files>/Bundles/anon/<hash>.bin，
#    并把 persistent_res_list.json / hot_update_list.json 里该条的 abSize 改成实际长度
#    （meta:1 ⇒ 客户端只比长度、不校验 md5），令牌可改成任意 4 位。
```
要点：
- **必须重签每个被改的资产**；客户端若用我们的公钥，则**全 bundle 每个资产**都要是我们签的。
- 签名固定 128B ⇒ 长度不变 ⇒ 不用重建 SF（重建 SF 的产物客户端不接受）。
- 公钥文件 `data/crypto/public.xml` 必须是**大端**（`scripts/sign-key.ts` 已修；官方资产内是 243B 等长替换）。
- 运行时换公钥**只对 Lua 加载上下文**生效（`_CustomLoader` 的 onEnter/onLeave 维护深度标记）：
  `VerifySignMD5RSA(byte[],byte[],string)` 同一个重载还服务 excel/DB 的 `_WithSign` 资产，
  全局换公钥会把 DB/excel 阶段打死。

## 红线
- 不重签名 APK 上线（ACE 会杀，见 `arknights-mumu-frida-debug`）、不绕 ACE、不做"验签恒 true"。
  换公钥 = **用自己的密钥对做真实验签**。

## 相关文档
`docs/lua-asset-signature-2026-09-14.md`（完整判定链与实验数据）、
`docs/lua-load-chain-reconstructed-2026-09-14.md`（资产寻址与容器格式）。
