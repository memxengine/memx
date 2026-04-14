/**
 * Minimal RGBA → PNG encoder with stored (uncompressed) deflate blocks.
 * Kept deliberately dependency-free so the pipeline works in any JS runtime.
 */

export function rgbaToPng(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  kind?: number,
): Uint8Array {
  // pdfjs image kinds:
  //   1 = GRAYSCALE_1BPP
  //   2 = RGB_24BPP
  //   3 = RGBA_32BPP
  let rgba: Uint8Array;
  if (kind === 3 || data.length === width * height * 4) {
    rgba = new Uint8Array(data);
  } else if (kind === 2 || data.length === width * height * 3) {
    rgba = new Uint8Array(width * height * 4);
    for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
      rgba[j] = data[i]!;
      rgba[j + 1] = data[i + 1]!;
      rgba[j + 2] = data[i + 2]!;
      rgba[j + 3] = 255;
    }
  } else if (data.length === width * height) {
    rgba = new Uint8Array(width * height * 4);
    for (let i = 0, j = 0; i < data.length; i++, j += 4) {
      rgba[j] = data[i]!;
      rgba[j + 1] = data[i]!;
      rgba[j + 2] = data[i]!;
      rgba[j + 3] = 255;
    }
  } else {
    rgba = new Uint8Array(data);
  }
  return encodePng(rgba, width, height);
}

function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = new Uint8Array(13);
  const ihdrView = new DataView(ihdrData.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = buildChunk('IHDR', ihdrData);

  const rowSize = width * 4;
  const raw = new Uint8Array(height * (1 + rowSize));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + rowSize)] = 0;
    raw.set(rgba.subarray(y * rowSize, (y + 1) * rowSize), y * (1 + rowSize) + 1);
  }

  const compressed = deflateStored(raw);
  const idat = buildChunk('IDAT', compressed);
  const iend = buildChunk('IEND', new Uint8Array(0));

  const total = signature.length + ihdr.length + idat.length + iend.length;
  const out = new Uint8Array(total);
  let offset = 0;
  out.set(signature, offset);
  offset += signature.length;
  out.set(ihdr, offset);
  offset += ihdr.length;
  out.set(idat, offset);
  offset += idat.length;
  out.set(iend, offset);
  return out;
}

function buildChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array(type.split('').map((c) => c.charCodeAt(0)));
  const chunk = new Uint8Array(8 + data.length + 4);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  const crc = crc32(chunk.subarray(4, 8 + data.length));
  view.setUint32(8 + data.length, crc);
  return chunk;
}

function deflateStored(data: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = [];
  const maxBlockSize = 65535;

  for (let i = 0; i < data.length; i += maxBlockSize) {
    const end = Math.min(i + maxBlockSize, data.length);
    const len = end - i;
    const isLast = end === data.length;
    const header = new Uint8Array(5);
    header[0] = isLast ? 1 : 0;
    header[1] = len & 0xff;
    header[2] = (len >> 8) & 0xff;
    header[3] = ~len & 0xff;
    header[4] = (~len >> 8) & 0xff;
    blocks.push(header);
    blocks.push(data.subarray(i, end));
  }

  const compressed = new Uint8Array(blocks.reduce((sum, b) => sum + b.length, 0));
  let offset = 0;
  for (const b of blocks) {
    compressed.set(b, offset);
    offset += b.length;
  }

  const adler = adler32(data);
  const out = new Uint8Array(2 + compressed.length + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  out.set(compressed, 2);
  const view = new DataView(out.buffer);
  view.setUint32(2 + compressed.length, adler);
  return out;
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
