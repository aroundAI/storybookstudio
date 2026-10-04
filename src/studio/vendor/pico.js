// pico.js, from https://github.com/nenadmarkus/picojs (pico.js, MIT licence,
// Copyright (c) 2013 Nenad Markus; licence text in
// electron/studio/models/README.md). Ported to an ES module for FILM-2017:
// unpack_cascade, run_cascade and cluster_detections are the upstream
// algorithms with the comments shortened; the frame-memory helper is left out.
// Pixel intensity comparisons over a grayscale image, no dependencies.

export function unpackCascade(bytes) {
  const view = new DataView(new ArrayBuffer(4))
  const int32At = (p) => {
    for (let i = 0; i < 4; i += 1) view.setUint8(i, bytes[p + i])
    return view.getInt32(0, true)
  }
  const float32At = (p) => {
    for (let i = 0; i < 4; i += 1) view.setUint8(i, bytes[p + i])
    return view.getFloat32(0, true)
  }
  // The first 8 bytes are the version and training data.
  let p = 8
  const tdepth = int32At(p)
  p += 4
  const ntrees = int32At(p)
  p += 4
  const leaves = 2 ** tdepth
  const tcodes = []
  const tpreds = []
  const thresh = []
  for (let t = 0; t < ntrees; t += 1) {
    tcodes.push(0, 0, 0, 0)
    for (let i = 0; i < 4 * leaves - 4; i += 1) tcodes.push(bytes[p + i] << 24 >> 24)
    p += 4 * leaves - 4
    for (let i = 0; i < leaves; i += 1) {
      tpreds.push(float32At(p))
      p += 4
    }
    thresh.push(float32At(p))
    p += 4
  }
  const codes = Int8Array.from(tcodes)
  const preds = Float32Array.from(tpreds)
  const thresholds = Float32Array.from(thresh)

  return function classifyRegion(r, c, s, pixels, ldim) {
    r *= 256
    c *= 256
    let root = 0
    let o = 0
    for (let i = 0; i < ntrees; i += 1) {
      let idx = 1
      for (let j = 0; j < tdepth; j += 1) {
        const a = pixels[((r + codes[root + 4 * idx] * s) >> 8) * ldim + ((c + codes[root + 4 * idx + 1] * s) >> 8)]
        const b = pixels[((r + codes[root + 4 * idx + 2] * s) >> 8) * ldim + ((c + codes[root + 4 * idx + 3] * s) >> 8)]
        idx = 2 * idx + (a <= b ? 1 : 0)
      }
      o += preds[leaves * i + idx - leaves]
      if (o <= thresholds[i]) return -1
      root += 4 * leaves
    }
    return o - thresholds[ntrees - 1]
  }
}

// Detections [row, col, size, score] at every scale between minsize and maxsize.
export function runCascade(image, classifyRegion, { shiftfactor = 0.1, minsize = 20, maxsize = 1000, scalefactor = 1.1 } = {}) {
  const { pixels, nrows, ncols, ldim } = image
  const detections = []
  for (let scale = minsize; scale <= maxsize; scale *= scalefactor) {
    const step = Math.max(shiftfactor * scale, 1) >> 0
    const offset = (scale / 2 + 1) >> 0
    for (let r = offset; r <= nrows - offset; r += step) {
      for (let c = offset; c <= ncols - offset; c += step) {
        const q = classifyRegion(r, c, scale, pixels, ldim)
        if (q > 0) detections.push([r, c, scale, q])
      }
    }
  }
  return detections
}

// Non-maximum suppression: overlapping detections merge into one cluster.
export function clusterDetections(input, iouThreshold = 0.2) {
  const dets = [...input].sort((a, b) => b[3] - a[3])
  const iou = (d1, d2) => {
    const [r1, c1, s1] = d1
    const [r2, c2, s2] = d2
    const overr = Math.max(0, Math.min(r1 + s1 / 2, r2 + s2 / 2) - Math.max(r1 - s1 / 2, r2 - s2 / 2))
    const overc = Math.max(0, Math.min(c1 + s1 / 2, c2 + s2 / 2) - Math.max(c1 - s1 / 2, c2 - s2 / 2))
    return (overr * overc) / (s1 * s1 + s2 * s2 - overr * overc)
  }
  const assigned = new Array(dets.length).fill(false)
  const clusters = []
  for (let i = 0; i < dets.length; i += 1) {
    if (assigned[i]) continue
    let r = 0
    let c = 0
    let s = 0
    let q = 0
    let n = 0
    for (let j = i; j < dets.length; j += 1) {
      if (iou(dets[i], dets[j]) > iouThreshold) {
        assigned[j] = true
        r += dets[j][0]
        c += dets[j][1]
        s += dets[j][2]
        q += dets[j][3]
        n += 1
      }
    }
    clusters.push([r / n, c / n, s / n, q])
  }
  return clusters
}
