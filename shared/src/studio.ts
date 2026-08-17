/**
 * Parametric props, as an asset identity (plan.md §2, amended).
 *
 * A generator plus its parameters is one string:
 *
 *     studio:table?length=2000&legProfile=turned
 *
 * The parameters ride inside the assetId because assetId is already a free
 * string, so supporting them cost the structured-output grammar nothing — see
 * CLAUDE.md on the size limit before moving them into a field of their own.
 *
 * Both sides read that string: the server to bake the mesh, the client to build
 * the URL it loads. So the parser lives here rather than in either.
 */

const PREFIX = "studio:";

export function isStudioAsset(assetId: string): boolean {
  return assetId.startsWith(PREFIX);
}

export function parseStudioAsset(assetId: string): { id: string; params: URLSearchParams } {
  const rest = assetId.slice(PREFIX.length);
  const q = rest.indexOf("?");
  return q === -1
    ? { id: rest, params: new URLSearchParams() }
    : { id: rest.slice(0, q), params: new URLSearchParams(rest.slice(q + 1)) };
}

/**
 * Where the baked glTF for this assetId lives. Same origin as everything else
 * (§14) — the client never talks to the studio, only to this server, which is
 * what keeps the generator sources on the trusted side of the boundary.
 */
export function studioAssetUrl(assetId: string): string {
  const { id, params } = parseStudioAsset(assetId);
  const query = params.toString();
  return `/api/assets/studio/${encodeURIComponent(id)}.glb${query ? `?${query}` : ""}`;
}
