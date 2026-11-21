import type {
  EpistemicItem,
  FlowUserSteer,
  HandoffEnvelope,
  Mandate,
  RoleSpec,
} from "../core/types.ts";

const DEFAULT_MAX_EPISTEMIC_ITEMS = 50;

/** Escape `<omp-enhance-conditioning>` delimiters inside dynamic content to prevent tag breakout. */
export function sanitizeConditioningText(text: string): string {
  return text.replace(/<\/?omp-enhance-conditioning\s*>/gi, (tag) =>
    tag.replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
  );
}

function bullets(title: string, values: readonly string[]): string[] {
  return [
    title,
    ...(values.length ? values.map((value) => `- ${sanitizeConditioningText(value)}`) : ["- (none)"]),
  ];
}

export function formatRuntimeVisionHint(
  visionCapable: boolean | null | undefined,
  roleId?: string,
): string | null {
  if (visionCapable === true) {
    if (roleId === "vision") {
      return "RuntimeVision: native-multimodal (current model sees images directly via read — inspect target images with read and report objective pixel/coordinate evidence)";
    }
    return 'RuntimeVision: native-multimodal (current model sees images directly via read — inspect key plots/images with your own eyes; delegate to role "vision" only for large-batch screening or independent blind review)';
  }
  if (visionCapable === false) {
    if (roleId === "vision") {
      return 'RuntimeVision: text-only (WARNING: no multimodal @vision model is configured; current model CANNOT see image pixels — do NOT guess image contents and do NOT self-delegate; submit verdict="blocked" requesting an authenticated vision-capable model)';
    }
    return 'RuntimeVision: text-only (current model CANNOT see image pixels — read strips images; you MUST delegate image inspection to role "vision" via enhance_handoff with toTarget="vision", delegateNow=true)';
  }
  return null;
}

export interface RenderConditioningBlockInput {
  role: RoleSpec;
  mandate?: Mandate | null;
  epistemicItems?: readonly EpistemicItem[];
  upstreamHandoff?: HandoffEnvelope | null;
  visionCapable?: boolean | null;
  userSteers?: readonly FlowUserSteer[];
  maxEpistemicItems?: number;
}

export function renderConditioningBlock(input: RenderConditioningBlockInput): string {
  const {
    role,
    mandate = null,
    epistemicItems = [],
    upstreamHandoff = null,
    visionCapable,
    userSteers = [],
    maxEpistemicItems = DEFAULT_MAX_EPISTEMIC_ITEMS,
  } = input;

  const permissions = role.permissions;
  const visionHint = formatRuntimeVisionHint(visionCapable, role.id);
  const lines = [
    "<omp-enhance-conditioning>",
    `## Active Role: ${role.id}`,
    `Name: ${sanitizeConditioningText(role.name)}`,
    `Source: ${role.source}`,
    ...(role.model || role.thinking
      ? [`ModelPref: model=${role.model ?? "inherit"}; thinking=${role.thinking ?? "inherit"}`]
      : []),
    ...(visionHint ? [visionHint] : []),
    "Stance:",
    sanitizeConditioningText(role.stance.trim()),
    "Method:",
    ...role.method.map((step, index) => `${index + 1}. ${sanitizeConditioningText(step)}`),
    `Permissions: tools=${permissions.tools?.join(", ") || (permissions.tools ? "(none)" : "(unrestricted)")}` +
      `; writable=${permissions.writable?.join(", ") || (permissions.writable ? "(none)" : "(unrestricted)")}` +
      `; protected=${permissions.protected?.join(", ") || "(none)"}`,
    `Exit: require_tool_evidence=${role.exit.requireToolEvidence}`,
    ...bullets("Exit criteria:", role.exit.criteria),
    "",
    "## Original Mandate",
  ];

  if (mandate) {
    lines.push(
      `Goal: ${sanitizeConditioningText(mandate.goal)}`,
      ...bullets("Constraints:", mandate.constraints),
      ...bullets("Acceptance:", mandate.acceptance),
    );
  } else {
    lines.push("(none)");
  }

  lines.push("", "## Epistemic Board");
  const activeItems = epistemicItems.filter(
    (item) => item.status !== "falsified" && item.status !== "deferred",
  );
  if (activeItems.length === 0) {
    lines.push("- (none)");
  } else {
    const omittedCount =
      maxEpistemicItems > 0 && activeItems.length > maxEpistemicItems
        ? activeItems.length - maxEpistemicItems
        : 0;
    const visibleItems = omittedCount > 0 ? activeItems.slice(-maxEpistemicItems) : activeItems;
    if (omittedCount > 0) {
      lines.push(`- (... ${omittedCount} older item(s) omitted ...)`);
    }
    for (const item of visibleItems) {
      const ev = item.evidenceRef ? ` (evidence: ${sanitizeConditioningText(item.evidenceRef)})` : "";
      lines.push(`- [${item.kind}/${item.status}] ${sanitizeConditioningText(item.statement)}${ev}`);
    }
  }

  lines.push("", "## Upstream Handoff");
  if (upstreamHandoff) {
    lines.push(
      `fromRole: ${sanitizeConditioningText(upstreamHandoff.fromRole)}`,
      `verdict: ${upstreamHandoff.verdict}`,
      `summary: ${sanitizeConditioningText(upstreamHandoff.summary)}`,
      ...bullets(
        "artifacts:",
        upstreamHandoff.artifacts.map(
          (artifact) => `${artifact.path} [${artifact.role}] sha256=${artifact.sha256}`,
        ),
      ),
      ...(upstreamHandoff.deletedFiles && upstreamHandoff.deletedFiles.length > 0
        ? bullets("deletedFiles:", upstreamHandoff.deletedFiles)
        : []),
      ...bullets(
        "verifiedFacts:",
        upstreamHandoff.verifiedFacts.map((f) => `${f.claim} (evidence: ${f.evidenceRef})`),
      ),
      ...bullets("openRisks:", upstreamHandoff.openRisks),
      `feedbackForUpstream: ${
        upstreamHandoff.feedbackForUpstream
          ? sanitizeConditioningText(upstreamHandoff.feedbackForUpstream)
          : "(none)"
      }`,
    );
  } else {
    lines.push("(none)");
  }

  const relevantSteers = userSteers.filter(
    (steer) => !steer.targetRole || steer.targetRole === role.id,
  );
  if (relevantSteers.length > 0) {
    lines.push(
      "",
      "## User Interjections",
      ...relevantSteers.map((steer) => {
        const prefix = steer.targetRole ? `[@${steer.targetRole}] ` : "";
        return `- ${prefix}${sanitizeConditioningText(steer.text)}`;
      }),
    );
  }

  lines.push("</omp-enhance-conditioning>");
  return lines.join("\n");
}
