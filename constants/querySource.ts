// Reconstructed from the bundled CLI literal emissions (`querySource: "..."`)
// and the FOREGROUND_529_RETRY_SOURCES set at tmp-recover-cli.js:208932.
//
// Consumers treat it as a string and use `.startsWith('repl_main_thread')` /
// Set membership. Colon-separated subkeys (`agent:custom`,
// `repl_main_thread:outputStyle:Learning`, etc.) are real — modelled with
// template-literal suffixes.

export type QuerySource =
  // REPL main-thread + its outputStyle sub-sources
  | 'repl_main_thread'
  | `repl_main_thread:${string}`
  // Agent-style sources (custom / default / builtin / named)
  | 'agent:custom'
  | 'agent:default'
  | 'agent:builtin'
  | `agent:${string}`
  // SDK / auto / verification paths
  | 'sdk'
  | 'auto_mode'
  | 'auto_dream'
  | 'verification_agent'
  | `verification_agent:${string}`
  // Compaction + context management
  | 'compact'
  | 'session_memory'
  | 'session_search'
  // Hook driven
  | 'hook_agent'
  | 'hook_prompt'
  // Side tasks / speculation / explainers
  | 'side_question'
  | 'speculation'
  | 'insights'
  | 'permission_explainer'
  | 'prompt_suggestion'
  // Summary + renaming
  | 'tool_use_summary_generation'
  | 'generate_session_title'
  | 'teleport_generate_title'
  | 'rename_generate_name'
  | 'agent_summary'
  | 'agent_creation'
  // MCP / Chrome / tooling
  | 'chrome_mcp'
  | 'mcp_datetime_parse'
  | 'web_search_tool'
  | 'web_fetch_apply'
  | 'bash_extract_prefix'
  // Skills / memory / docs
  | 'magic_docs'
  | 'memdir_relevance'
  | 'skill_improvement_apply'
  // Misc
  | 'feedback'
  | 'model_validation'
