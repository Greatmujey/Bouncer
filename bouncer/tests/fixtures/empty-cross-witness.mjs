// Synthetic-only empty peer for isolated unit tests. It is NOT a separate
// namespace, a real latest-head monitor or a deployable safety boundary.
export const emptyCrossWitness = witness => Object.freeze({
  async inspect(owner) { const { head } = await witness.inspect(owner); return { head, state: null }; },
});
