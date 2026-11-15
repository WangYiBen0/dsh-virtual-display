// Make a tool result survive the harness's lossless-JSON boundary.
//
// The harness snapshots every tool return value with `snapshotJsonValue` and
// rejects the whole call when it is not lossless JSON:
//
//     tool "virtual_display" returned invalid output: value is not lossless JSON
//
// The rule is stricter than `JSON.stringify`. Measured against the real
// validator, a value is REJECTED when it contains any of:
//
//   - an own property whose value is `undefined`  (even alongside valid keys)
//   - `NaN`, `Infinity`, or `-0`
//   - a sparse array, or an array element that is `undefined`
//   - a class instance, `Date`, `Map`, `Set`, or a function
//
// `JSON.stringify` silently drops `undefined` properties, so this is easy to
// violate without noticing: building an object with an optional field left
// unfilled produces exactly this failure. `snapshotJsonValue` does not drop
// them — it refuses the value.
//
// So every result this plugin returns passes through `lossless()` first. It
// mirrors `JSON.stringify`'s leniency deliberately: absent data becomes an
// absent key (or `null` inside an array, where the position must be kept)
// rather than an error the caller cannot act on.

/**
 * Rewrite a value so the harness will accept it.
 *
 * Object properties that are `undefined` are omitted; array elements that are
 * `undefined` become `null` so indices stay meaningful. Non-finite numbers and
 * values the JSON boundary cannot express are stringified rather than dropped,
 * because losing a diagnostic is worse than receiving it as text.
 *
 * @param value - Any value a tool wants to return.
 * @returns An equivalent value that is lossless JSON.
 */
export function lossless(value) {
  // Primitives first: the common case, and cheaper than any object walk.
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    // -0 is rejected too: it does not round-trip through JSON.
    return Number.isFinite(value) && !Object.is(value, -0) ? value : String(value)
  }
  if (value === undefined) return undefined

  if (Array.isArray(value)) {
    // A sparse array is rejected, and so is an `undefined` element; `null`
    // preserves the position, which matters for coordinate-style data.
    const out = []
    for (let index = 0; index < value.length; index += 1) {
      const item = Object.hasOwn(value, index) ? lossless(value[index]) : null
      out.push(item === undefined ? null : item)
    }
    return out
  }

  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'function' || typeof value === 'symbol') return String(value)

  if (typeof value === 'object') {
    // A `Date` is not accepted as an object, and its own keys are empty, so it
    // has to be converted before the generic walk.
    if (value instanceof Date) {
      return Number.isFinite(value.getTime()) ? value.toISOString() : String(value)
    }
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      // `Map`/`Set`/class instances are all rejected. Try their enumerable own
      // properties (works for plain-ish classes); otherwise fall back to text
      // so the caller still learns something.
      const entries = Object.entries(value)
      if (entries.length === 0) return String(value)
    }
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      // The one rule that bites most often: skip, never keep, an undefined.
      if (item === undefined) continue
      out[key] = lossless(item)
    }
    return out
  }

  return String(value)
}

/**
 * Report whether a value would pass the harness's lossless-JSON check.
 *
 * Kept here so the test can assert against the same rule the plugin obeys,
 * including the parts `JSON.stringify` hides.
 *
 * @param value - Value to test.
 * @returns True when the harness would accept it.
 */
export function isLossless(value) {
  if (value === null) return true
  const type = typeof value
  if (type === 'string' || type === 'boolean') return true
  if (type === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (type !== 'object') return false

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) return false
      if (!isLossless(value[index])) return false
    }
    return true
  }

  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return false
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor?.enumerable !== true) return false
    // A key whose value is `undefined` is a rejection, not an omission.
    if (!isLossless(value[key])) return false
  }
  return true
}
