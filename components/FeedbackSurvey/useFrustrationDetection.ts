// Phantom stub — frustration-detection hook. Not reconstructed in this
// external build. Gated at call site via `("external" as string) === 'ant'`.

export type FrustrationDetectionState = {
  state: 'closed' | 'open' | 'submitting' | 'thanks' | 'transcript_prompt' | 'submitted'
  handleTranscriptSelect: () => void
}

export function useFrustrationDetection(
  ..._args: unknown[]
): FrustrationDetectionState {
  return { state: 'closed', handleTranscriptSelect: () => {} }
}
