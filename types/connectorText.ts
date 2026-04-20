export type ConnectorTextBlock = {
  type: 'connector_text'
  connector_text: string
}

// Streaming delta variant emitted during content_block_delta events when the
// delta carries connector text. Discriminated on `.type === 'connector_text_delta'`.
export type ConnectorTextDelta = {
  type: 'connector_text_delta'
  connector_text: string
}

export function isConnectorTextBlock(
  value: unknown,
): value is ConnectorTextBlock {
  return (
    !!value &&
    typeof value === 'object' &&
    'type' in value &&
    'connector_text' in value &&
    (value as { type?: unknown }).type === 'connector_text' &&
    typeof (value as { connector_text?: unknown }).connector_text === 'string'
  )
}
