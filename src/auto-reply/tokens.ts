/** Token that marks a heartbeat response as an acknowledgement with no user notification. */
export const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
/** Token that marks an auto-reply response as intentionally silent. */
export const SILENT_REPLY_TOKEN = "NO_REPLY";

const HARMONY_CHANNEL_MARKER_RE = /^\s*(?:set-thought\s+)?<[\w]*\|[^>]*>\s*$/;
const BOX_DRAWING_HR_ONLY_RE = /^\s*─{3,}\s*$/;

export function isInternalFormattingArtifact(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  return HARMONY_CHANNEL_MARKER_RE.test(text) || BOX_DRAWING_HR_ONLY_RE.test(text);
}

/** Returns true only for the exact, case-insensitive whole-reply control token. */
export function isSilentReplyText(text?: string): boolean {
  return text?.trim().toUpperCase() === SILENT_REPLY_TOKEN;
}

/**
 * A whole message that is a shortened `NO_REPLY` and still contains the underscore.
 * `NO` stays visible so a short answer is not treated as silence.
 */
export function isTruncatedSilentReplyText(text?: string): boolean {
  const normalized = text?.trim().toUpperCase();
  if (!normalized || normalized.length < 3 || normalized.length >= SILENT_REPLY_TOKEN.length) {
    return false;
  }
  return SILENT_REPLY_TOKEN.startsWith(normalized);
}
