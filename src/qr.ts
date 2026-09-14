/**
 * Byte-mode QR (ECC M) → module matrix. No dependency; SVG is drawn by the UI.
 * Versions 1–16 cover lightning addresses, silent payments, and NIP-A3 payto URIs.
 */

const MAX_VERSION = 16;

/** Total codewords (data + ECC) per version. */
const TOTAL_CW = [
  0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655,
  733,
];

/** ECC codewords per block, level M. */
const EC_PER_BLOCK = [
  0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28,
];

/** Number of ECC blocks, level M. */
const EC_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10];

/** Remainder bits after ECC interleave. */
const REMAINDER_BITS = [
  0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0, 0, 0, 0, 3, 3, 3,
];

/** Alignment centers besides the three finders (6 is included in the table). */
const ALIGN_POS: number[][] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
];

const EXP = new Uint8Array(256);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a] + LOG[b]) % 255];
}

function rsDivisor(degree: number): Uint8Array {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}

function rsRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
  const result = new Uint8Array(divisor.length);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    if (factor === 0) continue;
    for (let i = 0; i < result.length; i++) {
      result[i] ^= gfMul(divisor[i], factor);
    }
  }
  return result;
}

function countBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

function dataCapacityBytes(version: number): number {
  const total = TOTAL_CW[version];
  const ecc = EC_PER_BLOCK[version] * EC_BLOCKS[version];
  return total - ecc;
}

function neededVersion(byteLength: number): number | null {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const capBits = dataCapacityBytes(v) * 8;
    const header = 4 + countBits(v);
    if (header + byteLength * 8 + 4 <= capBits) return v;
  }
  return null;
}

function buildDataBits(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const push = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4);
  push(bytes.length, countBits(version));
  for (const b of bytes) push(b, 8);

  const cap = dataCapacityBytes(version) * 8;
  const term = Math.min(4, cap - bits.length);
  for (let i = 0; i < term; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const pads = [0xec, 0x11];
  let pad = 0;
  while (bits.length < cap) {
    push(pads[pad % 2], 8);
    pad++;
  }
  return bits.slice(0, cap);
}

function bitsToBytes(bits: number[]): Uint8Array {
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < out.length; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j];
    out[i] = v;
  }
  return out;
}

function addEccAndInterleave(data: Uint8Array, version: number): Uint8Array {
  const numBlocks = EC_BLOCKS[version];
  const ecLen = EC_PER_BLOCK[version];
  const shortLen = Math.floor(data.length / numBlocks);
  const numLong = data.length % numBlocks;
  const numShort = numBlocks - numLong;
  const divisor = rsDivisor(ecLen);
  const blocks: { data: Uint8Array; ecc: Uint8Array }[] = [];
  let offset = 0;
  for (let i = 0; i < numBlocks; i++) {
    const len = shortLen + (i < numShort ? 0 : 1);
    const block = data.subarray(offset, offset + len);
    offset += len;
    blocks.push({ data: block, ecc: rsRemainder(block, divisor) });
  }

  const out = new Uint8Array(TOTAL_CW[version]);
  let k = 0;
  const maxData = shortLen + (numLong > 0 ? 1 : 0);
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) {
      if (i < block.data.length) out[k++] = block.data[i];
    }
  }
  for (let i = 0; i < ecLen; i++) {
    for (const block of blocks) out[k++] = block.ecc[i];
  }
  return out;
}

type Cell = 0 | 1 | null;

function emptyGrid(size: number): Cell[][] {
  return Array.from({ length: size }, () => Array<Cell>(size).fill(null));
}

function inBounds(size: number, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < size && y < size;
}

function placeFinder(grid: Cell[][], ox: number, oy: number): void {
  const size = grid.length;
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const x = ox + dx;
      const y = oy + dy;
      if (!inBounds(size, x, y)) continue;
      const dark =
        dx >= 0 &&
        dx <= 6 &&
        dy >= 0 &&
        dy <= 6 &&
        (dx === 0 ||
          dx === 6 ||
          dy === 0 ||
          dy === 6 ||
          (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
      grid[y][x] = dark ? 1 : 0;
    }
  }
}

function placeAlignment(grid: Cell[][], cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const ring = Math.max(Math.abs(dx), Math.abs(dy));
      grid[cy + dy][cx + dx] = ring === 1 ? 0 : 1;
    }
  }
}

function placeFunctionPatterns(grid: Cell[][], version: number): void {
  const size = grid.length;
  placeFinder(grid, 0, 0);
  placeFinder(grid, size - 7, 0);
  placeFinder(grid, 0, size - 7);

  for (let i = 8; i < size - 8; i++) {
    const bit: Cell = i % 2 === 0 ? 1 : 0;
    if (grid[6][i] === null) grid[6][i] = bit;
    if (grid[i][6] === null) grid[i][6] = bit;
  }

  const align = ALIGN_POS[version];
  const lastAlign = align.length - 1;
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      // Skip the three finder corners; overwrite timing where they meet.
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === lastAlign) ||
        (i === lastAlign && j === 0)
      ) {
        continue;
      }
      placeAlignment(grid, align[j], align[i]);
    }
  }

  grid[size - 8][8] = 1;

  for (let i = 0; i < 9; i++) {
    if (grid[8][i] === null) grid[8][i] = 0;
    if (grid[i][8] === null) grid[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (grid[8][size - 1 - i] === null) grid[8][size - 1 - i] = 0;
    if (grid[size - 1 - i][8] === null) grid[size - 1 - i][8] = 0;
  }

  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        grid[i][size - 11 + j] = 0;
        grid[size - 11 + j][i] = 0;
      }
    }
  }
}

function maskFn(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((y * x) % 2) + ((y * x) % 3) === 0;
    case 6:
      return (((y * x) % 2) + ((y * x) % 3)) % 2 === 0;
    default:
      return (((y + x) % 2) + ((y * x) % 3)) % 2 === 0;
  }
}

function formatBits(mask: number): number {
  // ECC M = 00
  const data = mask;
  let rem = data;
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) {
    rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  }
  return (version << 12) | rem;
}

function placeFormat(grid: Cell[][], bits: number): void {
  const size = grid.length;
  for (let i = 0; i <= 5; i++) {
    const bit = ((bits >>> i) & 1) as Cell;
    grid[i][8] = bit;
    grid[8][size - 1 - i] = bit;
  }
  const b6 = ((bits >>> 6) & 1) as Cell;
  grid[7][8] = b6;
  grid[8][size - 7] = b6;
  const b7 = ((bits >>> 7) & 1) as Cell;
  grid[8][8] = b7;
  grid[8][size - 8] = b7;
  const b8 = ((bits >>> 8) & 1) as Cell;
  grid[8][7] = b8;
  grid[size - 7][8] = b8;
  for (let i = 9; i <= 14; i++) {
    const bit = ((bits >>> i) & 1) as Cell;
    grid[8][14 - i] = bit;
    grid[size - 15 + i][8] = bit;
  }
}

function placeVersion(grid: Cell[][], bits: number): void {
  const size = grid.length;
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >>> i) & 1) as Cell;
    const a = Math.floor(i / 3);
    const b = (i % 3) + size - 11;
    grid[a][b] = bit;
    grid[b][a] = bit;
  }
}

function placeData(grid: Cell[][], data: Uint8Array, remainder: number): void {
  const size = grid.length;
  const bits: number[] = [];
  for (const byte of data) {
    for (let i = 7; i >= 0; i--) bits.push((byte >>> i) & 1);
  }
  for (let i = 0; i < remainder; i++) bits.push(0);

  let n = 0;
  for (let i = size - 1; i > 0; i -= 2) {
    if (i === 6) i--;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = i - j;
        const upward = ((i + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (grid[y][x] !== null) continue;
        grid[y][x] = (n < bits.length ? bits[n] : 0) as Cell;
        n++;
      }
    }
  }
}

function cloneGrid(grid: Cell[][]): Cell[][] {
  return grid.map((row) => row.slice());
}

function applyMask(grid: Cell[][], reserved: Cell[][], mask: number): void {
  const size = grid.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (reserved[y][x] !== null) continue;
      if (maskFn(mask, x, y)) {
        grid[y][x] = grid[y][x] ? 0 : 1;
      }
    }
  }
}

function runPenalty(line: Cell[]): number {
  let score = 0;
  let run = 1;
  for (let i = 1; i <= line.length; i++) {
    if (i < line.length && line[i] === line[i - 1]) {
      run++;
      continue;
    }
    if (run >= 5) score += run - 2;
    run = 1;
  }
  const s = line.map((c) => (c ? "1" : "0")).join("");
  for (const pat of ["00001011101", "10111010000"]) {
    let from = 0;
    for (;;) {
      const at = s.indexOf(pat, from);
      if (at < 0) break;
      score += 40;
      from = at + 1;
    }
  }
  return score;
}

function penalty(grid: Cell[][]): number {
  const size = grid.length;
  let score = 0;
  for (let y = 0; y < size; y++) score += runPenalty(grid[y]);
  for (let x = 0; x < size; x++) {
    const col: Cell[] = [];
    for (let y = 0; y < size; y++) col.push(grid[y][x]);
    score += runPenalty(col);
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = grid[y][x];
      if (
        v === grid[y][x + 1] &&
        v === grid[y + 1][x] &&
        v === grid[y + 1][x + 1]
      ) {
        score += 3;
      }
    }
  }
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (grid[y][x]) dark++;
    }
  }
  const k = Math.floor(Math.abs((dark * 20) / (size * size) - 10));
  score += k * 10;
  return score;
}

function finishGrid(
  dataGrid: Cell[][],
  reserved: Cell[][],
  version: number,
  mask: number
): Cell[][] {
  const grid = cloneGrid(dataGrid);
  applyMask(grid, reserved, mask);
  placeFormat(grid, formatBits(mask));
  if (version >= 7) placeVersion(grid, versionBits(version));
  return grid;
}

/** Module matrix, no quiet zone. Dark = true. */
export function encodeQrMatrix(text: string): boolean[][] | null {
  const bytes = new TextEncoder().encode(text);
  const version = neededVersion(bytes.length);
  if (version === null) return null;

  const size = 21 + 4 * (version - 1);
  const reserved = emptyGrid(size);
  placeFunctionPatterns(reserved, version);

  const dataBits = buildDataBits(bytes, version);
  const interleaved = addEccAndInterleave(bitsToBytes(dataBits), version);

  const dataGrid = cloneGrid(reserved);
  placeData(dataGrid, interleaved, REMAINDER_BITS[version]);

  let best: Cell[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = finishGrid(dataGrid, reserved, version, mask);
    const score = penalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (!best) return null;
  return best.map((row) => row.map((cell) => cell === 1));
}
