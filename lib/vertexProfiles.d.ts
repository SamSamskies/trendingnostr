/**
 * Pubkeys that have a kind 0 on Vertex's curated relay.
 * Returns `null` when Vertex could not be queried (fail-open: skip demotion).
 */
export declare function fetchVertexProfilePubkeys(
  pubkeys: string[]
): Promise<Set<string> | null>;
