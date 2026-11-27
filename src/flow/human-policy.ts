import type { HumanNodeConfig, HumanNodeMode, HumanOptionAction } from "../core/graph-types.ts";

export interface HumanReplyEvaluation {
  decision: "proceed" | "hold" | "cancel" | "invalid";
  mode: HumanNodeMode;
  matchedOption?: string;
  reason?: string;
}

const APPROVAL_PROMPT_RE =
  /(?:是否(?:批准|同意|确认|通过|继续|执行|放行|合并|应用|发布|部署|启动)|批准.{0,8}[？?]?$|确认是否|确定(?:清理|删除|执行|继续|发布|合并)|继续.{0,6}(?:吗|？|\?)|approve|proceed\?|confirm\s+(?:whether|if|to)\b|go\s+ahead)/i;
const INPUT_PROMPT_RE =
  /(?:指标|阈值|延迟|漏检|误报|P95|P99|预算|格式|特征|方案|偏好|参数|约束|目标|范围|metric|latency|threshold|budget|format|preference)/i;
const STATUS_QUERY_RE =
  /(?:进度|进展|状态|情况|到哪|卡在哪|卡在|还要多久|做完了吗|跑完了吗|怎么样了?|status|progress|update|how'?s|where are we|what'?s the status)/i;
const QUESTION_END_RE = /(?:[?？]|(?:吗|呢|么)[？?。!！\s]*)$/;

const DEFAULT_HOLD_OPTION_RE =
  /^(?:暂缓|暂停|稍后|稍等|等等|延后|搁置|先等等|待定|hold|defer|pause|later|wait)$/i;
const DEFAULT_CANCEL_OPTION_RE =
  /^(?:取消|拒绝|终止|中止|停止|不同意|不批准|驳回|否决|放弃|cancel|reject|abort|deny|stop|no)$/i;
const PURE_HOLD_RE =
  /(?:暂缓|暂停|稍等|等等|再看看|再看|还没决定|尚未决定|先等等|先别急|等我看看|等我确认|还要看|还需确认|另等通知|hold\s*on|wait\s+a\b|not\s+yet|defer\b|later\b)/i;
const PURE_CANCEL_RE =
  /^(?:取消|算了|停止|中止|终止|不做了|放弃|cancel|abort|stop)$|(?:取消(?:任务|流程|执行|本次)|终止(?:任务|流程)|算了不做)/i;
const APPROVAL_HOLD_RE =
  /(?:暂缓|暂停|稍等|等等|再看看|再看|还没|尚未|先不(?:要)?(?:批准|同意|确认|通过|放行|继续|执行)?|先别|别(?:再|继续|批准|同意|通过|放行)|等我|还要看|还需|hold\s*on|wait\b|not\s+yet|defer|later)/i;
const APPROVAL_CANCEL_RE =
  /^(?:取消|拒绝|不同意|不批准|不通过|驳回|否决|算了|放弃|cancel|reject|deny|abort|no)$|(?:明确|坚决)?(?:拒绝|取消|驳回|否决)(?:本次|此|该|执行|发布|交付|合并|任务|流程)?|不(?:同意|批准|通过|确认|放行)(?:执行|发布|交付|合并)?$/i;
const APPROVAL_NEGATION_RE =
  /(?:不要(?:批准|同意|确认|通过|放行|继续|执行|合并|发布)?|不批准|不同意|不确认|不通过|别批准|别继续|don'?t\s+(?:approve|proceed|run|execute|merge|deploy)|do\s+not\s+(?:approve|proceed|run|execute|merge|deploy))/i;

function normalizeOptionToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/^[（(「【"'\s]+|[）)」】"'\s。.!！?？]+$/g, "");
}

export function inferHumanNodeMode(config: HumanNodeConfig): HumanNodeMode {
  if (config.mode === "approval" || config.mode === "input") return config.mode;
  if (config.options && config.options.length > 0) return "approval";
  if (INPUT_PROMPT_RE.test(config.prompt) && !/是否(?:批准|同意|发布|执行|清理|删除)/.test(config.prompt)) {
    return "input";
  }
  return APPROVAL_PROMPT_RE.test(config.prompt) ? "approval" : "input";
}

function resolveOptionAction(config: HumanNodeConfig, matchedOption: string): HumanOptionAction {
  const actions = config.optionActions;
  if (actions) {
    if (actions[matchedOption]) return actions[matchedOption]!;
    const targetNorm = normalizeOptionToken(matchedOption);
    for (const [k, v] of Object.entries(actions)) {
      if (normalizeOptionToken(k) === targetNorm) return v;
    }
  }
  const norm = normalizeOptionToken(matchedOption);
  if (DEFAULT_HOLD_OPTION_RE.test(norm)) return "hold";
  if (DEFAULT_CANCEL_OPTION_RE.test(norm)) return "cancel";
  return "proceed";
}

export function evaluateHumanReply(config: HumanNodeConfig, rawReply: string): HumanReplyEvaluation {
  const mode = inferHumanNodeMode(config);
  const clean = rawReply.trim();
  if (!clean) {
    return { decision: "invalid", mode, reason: "User reply is empty; human gate remains paused." };
  }

  const options = config.options?.map((o) => o.trim()).filter(Boolean) ?? [];
  if (options.length > 0) {
    const cleanNorm = normalizeOptionToken(clean);
    const matched = options.find((opt) => normalizeOptionToken(opt) === cleanNorm);
    if (matched) {
      const action = resolveOptionAction(config, matched);
      if (action === "hold") {
        return { decision: "hold", mode, matchedOption: matched, reason: `User selected hold option "${matched}"; node remains waiting_input.` };
      }
      if (action === "cancel") {
        return { decision: "cancel", mode, matchedOption: matched, reason: `User selected cancel option "${matched}"; stopping downstream execution.` };
      }
      return { decision: "proceed", mode, matchedOption: matched };
    }
    if (config.allowFreeText === false) {
      return {
        decision: "invalid",
        mode,
        reason: `Reply "${clean}" is not one of the allowed options (${options.join(" / ")}) and free text is disabled.`,
      };
    }
  }

  if (QUESTION_END_RE.test(clean) || STATUS_QUERY_RE.test(clean)) {
    return {
      decision: "invalid",
      mode,
      reason: "User message is a question or status/progress query rather than a decision or answer; human gate remains paused.",
    };
  }

  if (mode === "approval") {
    if (APPROVAL_HOLD_RE.test(clean)) {
      return { decision: "hold", mode, reason: `Approval deferred by user ("${clean}"); node remains waiting_input.` };
    }
    if (APPROVAL_CANCEL_RE.test(clean)) {
      return { decision: "cancel", mode, reason: `Approval rejected/cancelled by user ("${clean}").` };
    }
    if (APPROVAL_NEGATION_RE.test(clean)) {
      return { decision: "hold", mode, reason: `Negative or non-approving reply ("${clean}"); approval gate remains paused.` };
    }
    return { decision: "proceed", mode };
  }

  // mode === "input": accept domain constraints including negations (e.g. "不要优化均值，以 P99 延迟为准").
  if (PURE_HOLD_RE.test(clean)) {
    return { decision: "hold", mode, reason: `Input deferred by user ("${clean}"); node remains waiting_input.` };
  }
  if (PURE_CANCEL_RE.test(clean)) {
    return { decision: "cancel", mode, reason: `Input gate cancelled by user ("${clean}").` };
  }
  return { decision: "proceed", mode };
}

export function isStatusOrProgressQuery(text: string, config?: HumanNodeConfig): boolean {
  return evaluateHumanReply(config ?? { prompt: "是否批准继续？", mode: "approval" }, text).decision !== "proceed";
}
