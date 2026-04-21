/**
 * Input payload passed to a user-configured `fileSuggestion` command hook.
 *
 * Built in `hooks/fileSuggestions.ts::generateFileSuggestions` and
 * JSON-stringified into the command's stdin by
 * `utils/hooks.ts::executeFileSuggestionCommand`.
 */
export type FileSuggestionCommandInput = {
  // Base hook fields (from createBaseHookInput)
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string

  // FileSuggestion-specific fields
  /** Partial path / typeahead query the user is currently typing. */
  query: string
}
