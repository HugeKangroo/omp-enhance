/**
 * Shared TUI rendering & ANSI/Kitty CSI-u input primitives for omp-enhance overlays.
 */

const ANSI_TOKEN_RE = /\x1b\[[0-9;:?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_CLOSING_SGR_RE = /^\x1b\[(?:0|22|23|24|27|28|29|39|49|59)?m$/;

type AnsiSegment = { kind: "ansi"; raw: string } | { kind: "char"; raw: string; width: number };

function segmentAnsiText(text: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(ANSI_TOKEN_RE)) {
    const idx = match.index!;
    if (idx > lastIndex) {
      for (const ch of Array.from(text.slice(lastIndex, idx))) {
        segments.push({ kind: "char", raw: ch, width: Bun.stringWidth(ch) });
      }
    }
    segments.push({ kind: "ansi", raw: match[0] });
    lastIndex = idx + match[0].length;
  }
  if (lastIndex < text.length) {
    for (const ch of Array.from(text.slice(lastIndex))) {
      segments.push({ kind: "char", raw: ch, width: Bun.stringWidth(ch) });
    }
  }
  return segments;
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_TOKEN_RE, "");
}

export function visibleWidth(text: string): number {
  return Bun.stringWidth(text);
}

/** ANSI-safe display truncation that never slices mid-escape and preserves closing SGR resets. */
export function truncateDisplay(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (Bun.stringWidth(text) <= maxWidth) return text;
  const segments = segmentAnsiText(text);
  const hasAnsi = segments.some((s) => s.kind === "ansi");
  if (!hasAnsi) {
    if (maxWidth === 1) return "…";
    let out = "";
    let used = 0;
    for (const seg of segments) {
      if (seg.kind !== "char") continue;
      if (used + seg.width + 1 > maxWidth) break;
      out += seg.raw;
      used += seg.width;
    }
    return `${out}…`;
  }

  let out = "";
  let used = 0;
  let truncatedAt = segments.length;
  const limit = maxWidth === 1 ? 0 : maxWidth - 1;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.kind === "ansi") {
      out += seg.raw;
      continue;
    }
    if (used + seg.width > limit) {
      truncatedAt = i;
      break;
    }
    out += seg.raw;
    used += seg.width;
  }

  let trailingResets = "";
  for (let i = truncatedAt; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.kind === "ansi" && ANSI_CLOSING_SGR_RE.test(seg.raw)) {
      trailingResets += seg.raw;
    }
  }
  return `${out}…${trailingResets}`;
}

export function padLeftCell(text: string, width: number): string {
  if (width <= 0) return "";
  const clipped = truncateDisplay(text, width);
  return clipped + " ".repeat(Math.max(0, width - Bun.stringWidth(clipped)));
}

export function padRightCell(text: string, width: number): string {
  if (width <= 0) return "";
  const clipped = truncateDisplay(text, width);
  return " ".repeat(Math.max(0, width - Bun.stringWidth(clipped))) + clipped;
}

export function wrapPlainText(text: string, maxWidth: number, maxLines = 4): string[] {
  const limit = Math.max(8, maxWidth);
  const out: string[] = [];
  for (const raw of (text || "").replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line) {
      if (out.length > 0 && out.length < maxLines) out.push("");
      continue;
    }
    const segments = segmentAnsiText(line);
    let cur = "";
    let curWidth = 0;
    for (const seg of segments) {
      if (seg.kind === "ansi") {
        cur += seg.raw;
        continue;
      }
      if (curWidth + seg.width > limit && curWidth > 0) {
        out.push(cur);
        if (out.length >= maxLines) {
          return [...out.slice(0, maxLines - 1), truncateDisplay(`${out[maxLines - 1]}…`, limit)];
        }
        cur = seg.raw;
        curWidth = seg.width;
      } else {
        cur += seg.raw;
        curWidth += seg.width;
      }
    }
    if (curWidth > 0 || cur) {
      out.push(cur);
      if (out.length > maxLines) {
        return [...out.slice(0, maxLines - 1), truncateDisplay(`${out[maxLines - 1]}…`, limit)];
      }
    }
  }
  return out.length > 0 ? out.slice(0, maxLines) : [""];
}

export interface ScrollWindow {
  start: number;
  end: number;
  hasAbove: boolean;
  hasBelow: boolean;
}

export function computeScrollWindow(
  total: number,
  selectedIndex: number,
  maxRows: number,
): ScrollWindow {
  if (total <= 0 || maxRows <= 0) {
    return { start: 0, end: 0, hasAbove: false, hasBelow: false };
  }
  const visible = Math.max(1, Math.min(total, maxRows));
  const clampedIndex = Math.max(0, Math.min(total - 1, selectedIndex));
  const half = Math.floor(visible / 2);
  const start = Math.max(0, Math.min(total - visible, clampedIndex - half));
  const end = start + visible;
  return {
    start,
    end,
    hasAbove: start > 0,
    hasBelow: end < total,
  };
}

export interface DecodedKittyKey {
  codepoint: number;
  shiftedCodepoint?: number;
  baseCodepoint?: number;
  modifiers: number;
  eventType: number;
  textCodepoints?: number[];
}

const KITTY_CSI_U_RE =
  /^\x1b\[(\d+)(?::(\d*))?(?::(\d*))?(?:;(\d*)(?::(\d*))?)?(?:;([\d:]*))?u$/;

export function decodeKittyCsiU(data: string): DecodedKittyKey | null {
  const match = KITTY_CSI_U_RE.exec(data);
  if (!match) return null;
  const eventType = match[5] ? Number(match[5]) : 1;
  if (eventType === 3) return null;
  const codepoint = Number(match[1]);
  const shiftedCodepoint = match[2] ? Number(match[2]) : undefined;
  const baseCodepoint = match[3] ? Number(match[3]) : undefined;
  const modifiers = match[4] ? Math.max(0, Number(match[4]) - 1) : 0;
  const textCodepoints = match[6]
    ? match[6]
        .split(":")
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= 32)
    : undefined;
  return {
    codepoint,
    ...(shiftedCodepoint !== undefined ? { shiftedCodepoint } : {}),
    ...(baseCodepoint !== undefined ? { baseCodepoint } : {}),
    modifiers,
    eventType,
    ...(textCodepoints && textCodepoints.length > 0 ? { textCodepoints } : {}),
  };
}

/** Normalize raw ANSI & Kitty keyboard protocol (CSI-u, including colon sub-parameters) keys. */
export function parseOverlayKey(data: string, kb?: any): string | null {
  if (!data || data.startsWith("\x1b[<")) return null;
  if (/^\x1b\[[0-9;:]*:3[u~A-Z]$/.test(data)) return null;
  if (kb?.matches?.(data, "tui.select.cancel") || kb?.matches?.(data, "app.interrupt")) {
    return "escape";
  }
  if (kb?.matches?.(data, "tui.select.up") || kb?.matches?.(data, "tui.editor.cursorUp")) {
    return "up";
  }
  if (kb?.matches?.(data, "tui.select.down") || kb?.matches?.(data, "tui.editor.cursorDown")) {
    return "down";
  }
  if (kb?.matches?.(data, "tui.editor.cursorRight")) return "right";
  if (kb?.matches?.(data, "tui.editor.cursorLeft")) return "left";
  if (kb?.matches?.(data, "tui.select.confirm") || kb?.matches?.(data, "tui.input.submit")) {
    return "enter";
  }
  if (kb?.matches?.(data, "tui.input.tab")) return "tab";

  const kitty = decodeKittyCsiU(data);
  if (kitty) {
    const cp = kitty.codepoint;
    const keyIdentity = cp >= 33 && cp <= 126 ? cp : (kitty.baseCodepoint ?? cp);
    const mod = kitty.modifiers;
    if (cp === 27 || ((mod & 4) !== 0 && (keyIdentity === 99 || keyIdentity === 67))) {
      return "escape";
    }
    if (cp === 13 || cp === 10) return "enter";
    if (cp === 9) return "tab";
    if (cp === 127 || cp === 8) return "backspace";
    if (cp === 32 && (mod & ~1) === 0) return "space";
    if ((mod & ~1) === 0 && cp >= 33 && cp <= 126) {
      if ((mod & 1) !== 0 && kitty.shiftedCodepoint && kitty.shiftedCodepoint >= 33 && kitty.shiftedCodepoint <= 126) {
        return String.fromCodePoint(kitty.shiftedCodepoint);
      }
      const ch = String.fromCodePoint(cp);
      return (mod & 1) !== 0 ? ch.toUpperCase() : ch;
    }
    return null;
  }

  if (data === "\x1b" || data === "\x1b\x1b" || data === "\x03") return "escape";
  if (data === "\r" || data === "\n") return "enter";
  if (data === "\t") return "tab";
  if (data === " ") return "space";
  if (data === "\x7f" || data === "\b" || data === "\x1b[3~") return "backspace";
  if (/^\x1b\[(?:1;\d+(?::[12])?)?A$/.test(data) || data === "\x1bOA") return "up";
  if (/^\x1b\[(?:1;\d+(?::[12])?)?B$/.test(data) || data === "\x1bOB") return "down";
  if (/^\x1b\[(?:1;\d+(?::[12])?)?C$/.test(data) || data === "\x1bOC") return "right";
  if (/^\x1b\[(?:1;\d+(?::[12])?)?D$/.test(data) || data === "\x1bOD") return "left";
  return data.length === 1 && data >= "!" && data <= "~" ? data : null;
}
