// The closed-form least-squares similarity transform (Umeyama), 2-D, with the
// reflection evaluated as its own hypothesis rather than being allowed to hide
// inside the rotation. A reflected drawing and a rotated one are different
// claims about the world and must be scored separately.

/** pts: [[px,py],...] source; qts: [[qx,qz],...] target.
 *  reflect=false gives det(R)=+1, true gives det(R)=-1. */
export function umeyama(pts, qts, reflect = false) {
  const n = pts.length;
  if (n < 2) return null;
  let mpx = 0, mpy = 0, mqx = 0, mqy = 0;
  for (let i = 0; i < n; i++) { mpx += pts[i][0]; mpy += pts[i][1]; mqx += qts[i][0]; mqy += qts[i][1]; }
  mpx /= n; mpy /= n; mqx /= n; mqy /= n;
  let s11 = 0, s12 = 0, s21 = 0, s22 = 0, varp = 0;
  for (let i = 0; i < n; i++) {
    const px = pts[i][0] - mpx, py = pts[i][1] - mpy;
    const qx = qts[i][0] - mqx, qy = qts[i][1] - mqy;
    s11 += qx * px; s12 += qx * py; s21 += qy * px; s22 += qy * py;
    varp += px * px + py * py;
  }
  if (varp < 1e-12) return null;
  let th, tr;
  if (!reflect) {
    th = Math.atan2(s21 - s12, s11 + s22);
    tr = (s11 + s22) * Math.cos(th) + (s21 - s12) * Math.sin(th);
  } else {
    th = Math.atan2(s12 + s21, s11 - s22);
    tr = (s11 - s22) * Math.cos(th) + (s12 + s21) * Math.sin(th);
  }
  const s = tr / varp;
  if (!(s > 0) || !isFinite(s)) return null;
  const c = Math.cos(th), si = Math.sin(th);
  const R = reflect ? [[c, si], [si, -c]] : [[c, -si], [si, c]];
  const A = [[s * R[0][0], s * R[0][1]], [s * R[1][0], s * R[1][1]]];
  const t = [mqx - (A[0][0] * mpx + A[0][1] * mpy), mqy - (A[1][0] * mpx + A[1][1] * mpy)];
  return { A, t, scale: s, thetaDeg: (th * 180) / Math.PI, reflect };
}

export const apply = (T, p) => [T.A[0][0] * p[0] + T.A[0][1] * p[1] + T.t[0],
                                T.A[1][0] * p[0] + T.A[1][1] * p[1] + T.t[1]];

export function invert(T) {
  const [[a, b], [c, d]] = T.A;
  const det = a * d - b * c;
  const A = [[d / det, -b / det], [-c / det, a / det]];
  const t = [-(A[0][0] * T.t[0] + A[0][1] * T.t[1]), -(A[1][0] * T.t[0] + A[1][1] * T.t[1])];
  return { A, t, scale: 1 / T.scale, thetaDeg: -T.thetaDeg, reflect: T.reflect };
}

export function residuals(T, pts, qts) {
  const errs = [];
  for (let i = 0; i < pts.length; i++) {
    const w = apply(T, pts[i]);
    errs.push(Math.hypot(w[0] - qts[i][0], w[1] - qts[i][1]));
  }
  const rms = Math.sqrt(errs.reduce((a, b) => a + b * b, 0) / Math.max(1, errs.length));
  return { errs, rms, worst: errs.length ? Math.max(...errs) : Infinity };
}
