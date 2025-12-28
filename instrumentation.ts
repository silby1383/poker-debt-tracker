// This file must be compatible with both Node and Edge runtimes.
// Avoid Node-only APIs (like process.on) because Next may compile this for Edge.

export async function register(): Promise<void> {
  // no-op
}

export async function onRequestError(): Promise<void> {
  // no-op
}
