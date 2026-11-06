/**
 * dsh-persona-runtime —— 把小羽的**活层人格**接进 DSH。
 *
 * 两个能力：
 *  1. **每轮自动注入人格**：`agent/pre-step` 里把「核心 + 关系层 + 偏好摘要 + 裁决顺序 +
 *     场景风格 + 边界示范」作为一条 plugin 消息插进请求。于是人格不再依赖
 *     `system-prompt` 里那段静态文本（profile 补丁生成一次就固定了），
 *     而是**每轮按情境重新装配**：换场景会换风格、换人会换关系档位、偏好生效会自动进来。
 *  2. **工具**：persona_status / persona_assemble / persona_observe / persona_auth /
 *     persona_drift / persona_health —— 模型可以直接查人格、记偏好、看漂移。
 *
 * 为什么背后是 Python sidecar（见 ./sidecar.js）：人格逻辑（四层 + 两道闸门 + 守卫 +
 * 漂移基线）已经有 88 项自检，Node 重写一遍必然两套语义。插件只注册工具、转发请求。
 *
 * 失败语义：sidecar 挂了 → 自动注入静默跳过、工具返回错误文本。**绝不让会话挂掉**。
 * 人格是增强层，退化了仍然是能用的 agent。
 */

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { PersonaSidecar } from "./sidecar.js";

export const name = "persona-runtime";
export const inject = ["tools", "agents"];

export const Config = z.object({
  /** persona 包的上层目录（含 persona/ 子包与可选的 channels/pylibs）。必填。 */
  projectRoot: z.string().required(),
  /** 当前对话者的身份，如 qq:2872422308 / wx:l2872422308 / bili:456479164；留空=匿名。 */
  actor: z.string().default(""),
  /** 偏好读数用哪个用户命名空间。 */
  userId: z.string().default("default"),
  /** 偏好后端：auto（能连 PG 就用）/ postgres / memory。 */
  backend: z.string().default("auto"),
  /** 覆盖 owner 白名单路径（默认项目内 state/owners.json）。 */
  ownersFile: z.string(),
  /** 覆盖关系配置路径。 */
  relFile: z.string(),
  pythonExe: z.string().default("python"),
  /** 是否注册工具。 */
  tools: z.boolean().default(true),
  /** 是否每轮自动注入人格。 */
  inject: z.boolean().default(true),
  /** 注入内容的字符上限（超了就只保留核心 + 关系，砍掉风格与示例）。 */
  injectBudget: z.number().min(400).max(12000).default(3000),
  /** 同一轮内重新装配的步数间隔（0 = 一轮只装配一次）。 */
  refreshSteps: z.number().min(0).max(50).default(0),
  /**
   * 是否把「核心」也注入。默认 false：核心应由 system-prompt 的 persona 段常驻
   * （静态、KV cache 友好），本插件只补活层（关系 / 偏好 / 场景风格 / 边界示范）。
   * profile 里没配 persona 段时把它设成 true。
   */
  includeCore: z.boolean().default(false),
  timeoutMs: z.number().min(1000).max(120000).default(30000),
});

const TEXT_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { text: { type: "string", required: true } },
  },
  render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
};

function errText(prefix, err) {
  const hint = err?.hint ? `（${err.hint}）` : "";
  return `${prefix}失败：${err?.message || err}${hint}`;
}

function textTool(spec) {
  return defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters || {},
    output: TEXT_OUTPUT,
    execute: async (args) => ({ text: await spec.run(args || {}) }),
  });
}

/** 从一条 plugin 消息里取最后一段用户文本（用来判场景 intent）。 */
function lastUserText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const parts = Array.isArray(m.content) ? m.content : [];
    const text = parts
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n")
      .trim();
    if (text) return text.slice(0, 400);
  }
  return "";
}

export function apply(ctx, config) {
  const log = (line) => {
    const logger = ctx.logger?.("persona-runtime");
    if (logger?.info) logger.info(line);
    else console.error(`[persona-runtime] ${line}`);
  };

  const sidecar = new PersonaSidecar({
    projectRoot: config.projectRoot,
    pythonExe: config.pythonExe,
    backend: config.backend,
    ownersFile: config.ownersFile,
    relFile: config.relFile,
    timeoutMs: config.timeoutMs,
    log,
  });
  ctx.effect?.(() => () => void sidecar.dispose());

  const actorArg = () => (config.actor ? config.actor : undefined);

  // -------------------------------------------------------------- 工具
  if (config.tools) {
    ctx.tools.register(
      textTool({
        name: "persona_status",
        description:
          "查看当前人格状态：核心版本与 token 数、硬边界条数、决策优先级、owner 白名单、active/pending 偏好。" +
          "怀疑『她是不是变了』、或用户问『你的人格是什么』时先调这个。",
        parameters: {},
        run: async () => {
          try {
            const r = await sidecar.request("status", { backend: config.backend, user_id: config.userId });
            const lines = [
              `人格：${r.name}（核心 v${r.core_version}，${r.core_tokens} tokens）`,
              `决策优先级：${(r.priority || []).join(" > ")}`,
              `硬边界 ${r.boundaries} 条；行为规则 ${(r.rules || []).length} 条`,
              `owner 白名单 ${(r.owners || []).length} 个：${(r.owners || []).join("、")}`,
              `偏好后端 ${r.backend}｜生效 ${(r.traits_active || []).length} 条` +
                (r.traits_active?.length ? `：${r.traits_active.join("、")}` : ""),
              `待 owner 批准 ${(r.traits_pending_owner || []).length} 条` +
                (r.backend_error ? `｜后端错误：${r.backend_error}` : ""),
            ];
            return lines.join("\n");
          } catch (err) {
            return errText("查人格状态", err);
          }
        },
      }),
    );

    ctx.tools.register(
      textTool({
        name: "persona_assemble",
        description:
          "按给定情境装配一遍人格段（核心 + 关系层 + 偏好 + 裁决顺序 + 场景风格 + 边界示范），" +
          "返回装配结果与 token 占用。想看'这一轮的人格到底长什么样'、或排查语气不对时用它。",
        parameters: {
          user_input: { type: "string", description: "要模拟的用户输入（决定场景 intent）。" },
          actor: { type: "string", description: "对话者身份，如 qq:xxx；留空用插件配置。" },
          with_notes: { type: "boolean", description: "附带装配信息（tokens/分段/tier）。" },
        },
        run: async (args) => {
          try {
            const r = await sidecar.request("assemble", {
              user_input: args.user_input || "",
              actor: args.actor || actorArg(),
              user_id: config.userId,
              backend: config.backend,
              with_system_notes: !!args.with_notes,
            });
            return r.text;
          } catch (err) {
            return errText("装配人格", err);
          }
        },
      }),
    );

    ctx.tools.register(
      textTool({
        name: "persona_observe",
        description:
          "记录一条长期偏好证据（如 address_as=老王 / verbosity=short / format_pref=plain）。" +
          "走两道闸门：跨会话计数（同会话重复不叠加）、撞硬边界直接 retired。",
        parameters: {
          key: {
            type: "string",
            required: true,
            enum: ["address_as", "verbosity", "format_pref", "certainty_policy", "nickname_style"],
            description: "偏好类别。",
          },
          value: { type: "json", description: '偏好值，如 {"name":"老王"} 或 {"level":"short"}。' },
          quote: { type: "string", description: "用户原话（撞边界判定要看原话）。" },
          session_id: { type: "string", description: "会话 id，默认 adhoc。" },
          actor: { type: "string", description: "谁说的，如 qq:xxx；留空用插件配置。" },
        },
        run: async (args) => {
          try {
            const r = await sidecar.request("observe", {
              key: args.key,
              value: args.value,
              quote: args.quote || "",
              session_id: args.session_id || "adhoc",
              actor: args.actor || actorArg(),
              user_id: config.userId,
              backend: config.backend,
            });
            const ownerNote = r.pending_owner ? "（证据够了，等 owner 批准才生效）" : "";
            return (
              `偏好 ${args.key} → ${r.status}${ownerNote}\n` +
              `裁决=${r.action}｜证据 ${r.evidence_count} 个会话｜置信度 ${r.confidence}｜关系档 ${r.tier}\n` +
              `理由：${r.reason}`
            );
          } catch (err) {
            return errText("记录偏好", err);
          }
        },
      }),
    );

    ctx.tools.register(
      textTool({
        name: "persona_auth",
        description:
          "查某个身份能对人格做什么：是否 owner、属于哪档关系（closest/familiar/stranger）、" +
          "能执行哪些特权动作。改核心/批准偏好之前先确认身份。",
        parameters: {
          actor: { type: "string", description: "身份，如 qq:2872422308；留空用插件配置。" },
        },
        run: async (args) => {
          try {
            const r = await sidecar.request("auth", { actor: args.actor || actorArg() });
            return [
              `身份：${r.actor}｜owner=${r.is_owner}｜关系档：${r.relationship.tier}（${r.relationship.label}）`,
              `允许：${Object.keys(r.can).join("、") || "（无特权动作）"}`,
              `不允许：${r.cannot.join("、") || "（全部允许）"}`,
            ].join("\n");
          } catch (err) {
            return errText("查权限", err);
          }
        },
      }),
    );

    ctx.tools.register(
      textTool({
        name: "persona_drift",
        description:
          "用最近的用户输入与助手回复算一次漂移分（锚点集 + 加权聚合）。" +
          "分数超过阈值说明行为偏离了设定的人格锚点，需要重读人格段。",
        parameters: {
          prompts: { type: "array", items: { type: "string" }, description: "最近几条用户输入。" },
          replies: { type: "array", items: { type: "string" }, description: "最近几条助手回复。" },
        },
        run: async (args) => {
          try {
            const r = await sidecar.request("drift", {
              prompts: args.prompts || [],
              replies: args.replies || [],
            });
            const top = (r.top_violated || []).join("、") || "（无）";
            return `漂移分 ${r.score}（阈值 ${r.threshold}，触发=${r.triggered}）\n被违反的锚点：${top}`;
          } catch (err) {
            return errText("算漂移", err);
          }
        },
      }),
    );

    ctx.tools.register(
      textTool({
        name: "persona_health",
        description: "人格层体检：核心能否渲染、偏好后端能否连通。人格行为异常时先跑这个。",
        parameters: {},
        run: async () => {
          try {
            const r = await sidecar.request("health", { backend: config.backend });
            return (
              `核心：${r.core_ok ? `ok（v${r.core_version}，${r.core_tokens} tokens）` : `失败 ${r.core_error}`}\n` +
              `偏好后端：${r.store}（${r.store_ok ? "连通" : `不可用 ${r.store_error || ""}`}）`
            );
          } catch (err) {
            return errText("人格体检", err);
          }
        },
      }),
    );
  }

  // -------------------------------------------------------------- 每轮注入
  if (!config.inject) return;

  const cache = new Map();
  const HEAD = "人格（小羽·自动装配）";

  ctx.on(
    "agent/pre-step",
    async ({ agent, turn, step, signal }, next) => {
      const decision = await next();
      if (decision?.kind === "reject" || signal?.aborted) return decision;

      const refresh = config.refreshSteps;
      const due = step === 1 || (refresh > 0 && (step - 1) % refresh === 0);
      if (!due) return decision;

      const key = `${agent?.id ?? "?"}:${turn}`;
      let text = cache.get(key);
      if (text === undefined) {
        const userInput = lastUserText(decision?.messages);
        try {
          const r = await sidecar.request("assemble", {
            user_input: userInput,
            actor: actorArg(),
            user_id: config.userId,
            backend: config.backend,
            omit_core: !config.includeCore,
          });
          text = String(r.text || "");
          // 超预算就只保留核心 + 关系（砍掉风格与示例），别把整块丢掉
          if (text.length > config.injectBudget) {
            const cut = text.indexOf("## 场景风格");
            text = cut > 0 ? text.slice(0, cut).trim() : text.slice(0, config.injectBudget);
            log(`人格段超预算（>${config.injectBudget} 字符），已裁到核心+关系`);
          }
        } catch (err) {
          log(`人格注入跳过：${err?.message || err}`);
          text = "";
        }
        cache.set(key, text);
        if (cache.size > 8) cache.delete(cache.keys().next().value);
      }
      if (!text) return decision;

      const body = `${HEAD}（每轮按情境重新装配：核心不可变，风格/关系/偏好是活层；"需要看结构再调 persona_assemble"）\n${text}`;
      return {
        kind: "enter",
        messages: [
          ...(decision.messages || []),
          {
            id: globalThis.crypto.randomUUID(),
            role: "user",
            content: [{ type: "text", text: body }],
            source: {
              kind: "plugin",
              plugin: name,
              form: "snapshot",
              sections: [{ name: HEAD, text: body }],
            },
          },
        ],
      };
    },
    { prepend: true },
  );
}
