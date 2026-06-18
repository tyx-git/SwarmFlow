// Re-export React's JSX namespace globally for the renderer.
// React 19 removed the implicit global; this restores ergonomics for
// `: JSX.Element` return-type annotations without rewriting every file.
import type { JSX as ReactJSX } from 'react'

declare global {
  namespace JSX {
    type Element = ReactJSX.Element
    type IntrinsicElements = ReactJSX.IntrinsicElements
    type LibraryManagedAttributes<C, P> = ReactJSX.LibraryManagedAttributes<C, P>
  }
}
