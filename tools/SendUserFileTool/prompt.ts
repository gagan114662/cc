/**
 * Phantom stub — constants/prompt strings for the SendUserFile tool
 * (KAIROS brief-mode attachment path).
 *
 * Callsites only reference `SEND_USER_FILE_TOOL_NAME` via typeof-import
 * guarded by feature('KAIROS'), so we expose the canonical name literal.
 */

// FIXME: tool-name literal guessed from sibling BriefTool naming ('SendUserMessage').
// Confirm against the original source — may be 'SendUserFile' or similar.
export const SEND_USER_FILE_TOOL_NAME = 'SendUserFile'
