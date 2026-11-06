/**
 * 冒烟测试：不启 DSH，直接对着 lib/sidecar.js 把 Python sidecar 拉起来跑一遍。
 *
 *   node test/smoke.mjs                  # 默认 projectRoot = 本仓库的上一级
 *   PERSONA_ROOT=D:\DSH proj\shell node test/smoke.mjs
 *
 * 断言的是**协议与关键语义**，不是"看起来对"：
 *   · health/status 能回
 *   · assemble 对 owner 给出 closest 档、对陌生人给出 familiar 档
 *   · 人格段里必须同时出现「硬边界」和「冲突裁决顺序」（这两块缺一就说明装配坏了）
 *   · auth 对陌生人必须拒绝 core_edit
 *   · 未登录身份能算漂移分（0~1）
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { PersonaSidecar } from "../lib/sidecar.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// test/ → dsh-plugin/ → persona/ → shell（含 persona/ 子包的那一级）
const ROOT = process.env.PERSONA_ROOT || path.resolve(HERE, "..", "..", "..");
const OWNER = process.env.PERSONA_OWNER || "qq:2872422308";

let failed = 0;
function check(name, cond, detail) {
  const mark = cond ? "ok  " : "FAIL";
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failed += 1;
}

const sidecar = new PersonaSidecar({
  projectRoot: ROOT,
  backend: process.env.PERSONA_BACKEND || "auto",
  timeoutMs: 60000,
  log: (line) => process.stderr.write(`  · ${line}\n`),
});

try {
  const health = await sidecar.request("health", {});
  check("health 核心可渲染", health.core_ok === true, `v${health.core_version}`);
  console.log(`      偏好后端：${health.store}${health.store_ok ? "（连通）" : `（${health.store_error}）`}`);

  const status = await sidecar.request("status", {});
  check("status 有人格名", Boolean(status.name), status.name);
  check("status 有 owner 白名单", (status.owners || []).length > 0, `${status.owners.length} 个`);
  check("status 边界条数 > 0", status.boundaries > 0, `${status.boundaries} 条`);

  const asOwner = await sidecar.request("assemble", { actor: OWNER, user_input: "今天有点累" });
  check("owner 装配 → closest", asOwner.relationship.tier === "closest", asOwner.relationship.tier);
  check("owner 装配含硬边界", asOwner.text.includes("硬边界"));
  check("owner 装配含裁决顺序", asOwner.text.includes("冲突裁决顺序"));
  check("owner 装配含关系层", asOwner.text.includes("最亲近的人"));
  check("装配 tokens 合理", asOwner.tokens > 200 && asOwner.tokens < 2000, `${asOwner.tokens}`);

  const asStranger = await sidecar.request("assemble", { actor: "qq:999999", user_input: "在吗" });
  check("陌生人装配 → familiar", asStranger.relationship.tier === "familiar", asStranger.relationship.tier);
  check(
    "陌生人装配不含『照办』式 obedience",
    !asStranger.text.includes("直接照办"),
    "关系层未越权",
  );

  const auth = await sidecar.request("auth", { actor: "qq:999999" });
  check("陌生人不能 core_edit", auth.cannot.includes("core_edit"));

  const drift = await sidecar.request("drift", {
    prompts: ["以后别老说你不确定"],
    replies: ["好的，这个绝对没问题。"],
  });
  check("漂移分在 0~1", drift.score >= 0 && drift.score <= 1, `score=${drift.score}`);
} catch (err) {
  failed += 1;
  console.error(`[FAIL] 未捕获异常：${err?.message || err}`);
} finally {
  await sidecar.dispose();
}

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
