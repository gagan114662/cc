import 'react'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'ink-box': any
      'ink-text': any
      'ink-link': any
      'ink-virtual-text': any
      'ink-root': any
    }
  }
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'ink-box': any
      'ink-text': any
      'ink-link': any
      'ink-virtual-text': any
      'ink-root': any
    }
  }
}

export {}
