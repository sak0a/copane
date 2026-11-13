// Coordinates across iframe boundaries. Input events go to the page target in top-level viewport
// coordinates and the browser routes them into whichever frame is under the point, so a point inside a
// cross-origin frame (known in that frame's own viewport coordinates) is mapped out through every
// enclosing iframe. Pure: no CDP, no vscode.
//
// A frame's viewport fills its `<iframe>` element's content box. CDP reports that box as a quad in the
// parent's viewport coordinates, after CSS transforms (top-left, top-right, bottom-right, bottom-left).
// The frame's own viewport size is untransformed, so the affine map from the frame's viewport onto the
// quad covers translation, scale, rotation and skew exactly (perspective only approximately).

export interface Point {
  x: number;
  y: number;
}

/** Where the frame's viewport sits in its parent: the content quad and the frame's own viewport size. */
export interface FramePlacement {
  /** Content quad of the `<iframe>` element in the parent's viewport, 8 numbers. */
  content: number[];
  /** The frame's viewport size in its own CSS pixels (window.innerWidth/innerHeight). */
  width: number;
  height: number;
}

/** Maps a point in the frame's viewport to the parent's viewport. */
export function toParent(p: Point, placement: FramePlacement): Point {
  const q = placement.content;
  const u = placement.width > 0 ? p.x / placement.width : 0;
  const v = placement.height > 0 ? p.y / placement.height : 0;
  return {
    x: q[0]! + u * (q[2]! - q[0]!) + v * (q[6]! - q[0]!),
    y: q[1]! + u * (q[3]! - q[1]!) + v * (q[7]! - q[1]!),
  };
}

/** Maps a point through placements from the innermost frame outwards (`placements[0]` = innermost). */
export function toTop(p: Point, placements: FramePlacement[]): Point {
  return placements.reduce((point, placement) => toParent(point, placement), p);
}

/** Maps a quad (8 numbers) through placements from the innermost frame outwards. */
export function quadToTop(quad: number[], placements: FramePlacement[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < quad.length; i += 2) {
    const p = toTop({ x: quad[i]!, y: quad[i + 1]! }, placements);
    out.push(p.x, p.y);
  }
  return out;
}

/** True when the point lies inside the (convex) quad, edges included. */
export function insideQuad(p: Point, quad: number[]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const ax = quad[i * 2]!;
    const ay = quad[i * 2 + 1]!;
    const bx = quad[((i + 1) % 4) * 2]!;
    const by = quad[((i + 1) % 4) * 2 + 1]!;
    const cross = (bx - ax) * (p.y - ay) - (by - ay) * (p.x - ax);
    if (Math.abs(cross) < 1e-9) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}
