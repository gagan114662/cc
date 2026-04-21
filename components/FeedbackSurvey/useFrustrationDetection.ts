// Phantom stub — frustration-detection hook. Not reconstructed in this
// external build. Gated at call site via `USER_TYPE === 'ant'`.

import { USER_TYPE } from '../../utils/buildConstants.js'

export type FrustrationDetectionState = {
  state: 'closed' | 'open' | 'submitting' | 'thanks' | 'transcript_prompt' | 'submitted'
  handleTranscriptSelect: () => void
}

export function useFrustrationDetection(
  ..._args: unknown[]
): FrustrationDetectionState {
  return { state: 'closed', handleTranscriptSelect: () => {} }
}
