/**
 * Shared TypeScript utility types.
 *
 * Reconstructed from usage evidence:
 *   - `state/AppStateStore.ts`         — `DeepImmutable<{...}>` on AppState (Maps, Sets, arrays)
 *   - `Tool.ts`                        — `DeepImmutable<{ readonly ... ReadonlyMap ... }>`
 *   - `utils/messages.ts`              — `DeepImmutable<Array<ContentBlockParam>>` read via
 *                                         structural typing (arrays become ReadonlyArray)
 *   - `utils/messages/mappers.ts`      — `readonly DeepImmutable<SDKMessage>[]`
 *   - `components/tasks/*.tsx`         — `DeepImmutable<*TaskState>` passed to React components
 *   - `types/permissions.ts`           — inline "simplified DeepImmutable approximation"
 *                                         (Map -> ReadonlyMap, fields become readonly)
 *   - `utils/messageQueueManager.ts`   — `Permutations<Exclude<PromptInputMode, ...>>` used
 *                                         with `satisfies` on a tuple literal, so the type
 *                                         must produce tuple unions of its input.
 *
 * `Permutations<T>` is the classic "all orderings of a union as a tuple" utility
 * (see TS issue #13298 community solution). With a one-element union it reduces
 * to `[T]`, matching the single-element `['task-notification']` literal at the
 * only callsite (messageQueueManager.ts:345).
 */

// ---------------------------------------------------------------------------
// DeepImmutable<T>
// ---------------------------------------------------------------------------
//
// Recursively marks every property of T as readonly. Handles the containers
// actually used inside AppState / Tool / SDK message trees:
//   - primitives / functions: passthrough (function types must not be stripped —
//     AppStateStore.ts:163 notes that TaskState contains function types and is
//     *excluded* from DeepImmutable for that reason)
//   - Map<K, V>  -> ReadonlyMap<DeepImmutable<K>, DeepImmutable<V>>
//   - Set<V>     -> ReadonlySet<DeepImmutable<V>>
//   - Array<V>   -> ReadonlyArray<DeepImmutable<V>>
//   - object     -> { readonly [K in keyof T]: DeepImmutable<T[K]> }
//
// This matches the structural expectations at the callsites — e.g. reading
// `.source.type` / `.source.data` off `DeepImmutable<Array<ContentBlockParam>>`
// in utils/messages.ts only works if arrays stay indexable and object fields
// stay accessible.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFunction = (...args: any[]) => any

export type DeepImmutable<T> = T extends AnyFunction
  ? T
  : T extends ReadonlyMap<infer K, infer V>
    ? ReadonlyMap<DeepImmutable<K>, DeepImmutable<V>>
    : T extends ReadonlySet<infer V>
      ? ReadonlySet<DeepImmutable<V>>
      : T extends ReadonlyArray<infer V>
        ? ReadonlyArray<DeepImmutable<V>>
        : T extends object
          ? { readonly [K in keyof T]: DeepImmutable<T[K]> }
          : T

// ---------------------------------------------------------------------------
// Permutations<T>
// ---------------------------------------------------------------------------
//
// Produces the union of all tuples that are permutations of the union T.
// Example:  Permutations<'a' | 'b'>  =  ['a', 'b'] | ['b', 'a']
//           Permutations<'a'>        =  ['a']
//           Permutations<never>      =  []
//
// Only callsite (utils/messageQueueManager.ts:345) uses it with
// `satisfies Permutations<Exclude<PromptInputMode, EditablePromptInputMode>>`
// against the literal tuple `['task-notification']`. The classic distributive
// formulation below satisfies that check.

export type Permutations<T, U = T> = [T] extends [never]
  ? []
  : T extends T
    ? [T, ...Permutations<Exclude<U, T>>]
    : never
