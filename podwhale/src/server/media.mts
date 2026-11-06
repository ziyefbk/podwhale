/**
 * 图片的"进门检查"：认类型、去元数据。
 *
 * 不用任何依赖——只处理 PNG / JPEG / WebP 三种，够用且可测。
 * 剥离的是**元数据**，不碰像素：EXIF 里常有拍摄地点、设备序列号、编辑软件账号，
 * 这些不该跟着一张社区配图流出去。
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export type ImageKind = 'png' | 'jpeg' | 'webp';

/** 靠文件头认类型，不信 content-type。 */
export function sniff(buffer: unknown): ImageKind | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

export function extensionOf(kind: unknown): 'jpg' | 'webp' | 'png' | null {
  if (kind === 'jpeg') return 'jpg';
  if (kind === 'webp') return 'webp';
  if (kind === 'png') return 'png';
  return null;
}

export function mimeOf(kind: unknown): string {
  if (kind === 'jpeg') return 'image/jpeg';
  if (kind === 'webp') return 'image/webp';
  if (kind === 'png') return 'image/png';
  return 'application/octet-stream';
}

// 只保留渲染必需和颜色相关的块；tEXt / iTXt / zTXt / eXIf 一律丢掉。
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'sRGB', 'pHYs', 'acTL', 'fcTL', 'fdAT', 'cHRM']);

function stripPng(buffer: Buffer): Buffer {
  const parts = [buffer.subarray(0, 8)];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const end = offset + 8 + length + 4;
    if (end > buffer.length || end < offset) break;
    if (PNG_KEEP.has(type)) parts.push(buffer.subarray(offset, end));
    offset = end;
  }
  return Buffer.concat(parts);
}

function stripJpeg(buffer: Buffer): Buffer {
  const parts = [buffer.subarray(0, 2)];
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      parts.push(buffer.subarray(offset));
      break;
    }
    const marker = buffer.readUInt8(offset + 1);
    if (marker === 0xd9) { // EOI
      parts.push(buffer.subarray(offset, offset + 2));
      break;
    }
    if (marker === 0xda) { // SOS：后面全是压缩数据，原样带走
      parts.push(buffer.subarray(offset));
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(buffer.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    const end = offset + 2 + length;
    if (end > buffer.length) break;
    // 丢 APP1(EXIF/XMP) 和 APP13(IPTC) 与注释；保留 APP0 和 APP2(ICC 色彩配置)
    const drop = marker === 0xfe || (marker >= 0xe1 && marker <= 0xef && marker !== 0xe2);
    if (!drop) parts.push(buffer.subarray(offset, end));
    offset = end;
  }
  return Buffer.concat(parts);
}

function stripWebp(buffer: Buffer): Buffer {
  const body: Buffer[] = [];
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const type = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const end = offset + 8 + size + (size % 2);
    if (end > buffer.length || end < offset) break;
    if (type !== 'EXIF' && type !== 'XMP ') body.push(buffer.subarray(offset, end));
    offset = end;
  }
  const header = Buffer.from(buffer.subarray(0, 12));
  const joined = Buffer.concat(body);
  header.writeUInt32LE(joined.length + 4, 4);
  return Buffer.concat([header, joined]);
}

/** 去掉元数据，保留像素。类型不认识就原样返回。 */
export function stripMetadata(buffer: Buffer, kind: unknown): Buffer {
  try {
    if (kind === 'png') return stripPng(buffer);
    if (kind === 'jpeg') return stripJpeg(buffer);
    if (kind === 'webp') return stripWebp(buffer);
  } catch (error) {
    return buffer;
  }
  return buffer;
}
