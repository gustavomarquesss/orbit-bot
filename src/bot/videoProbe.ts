interface Box {
  type: string;
  start: number;
  end: number;
}

function readBoxes(buf: Buffer, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    const size32 = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    let headerSize = 8;
    let size = size32;
    if (size32 === 1) {
      if (offset + 16 > end) break;
      const high = buf.readUInt32BE(offset + 8);
      const low = buf.readUInt32BE(offset + 12);
      size = high * 2 ** 32 + low;
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) break;
    boxes.push({ type, start: offset + headerSize, end: offset + size });
    offset += size;
  }
  return boxes;
}

/**
 * Lê `width`/`height` do `tkhd` de uma trilha, já corrigindo a rotação
 * (celulares gravam vídeo vertical como um frame landscape + flag de
 * rotação 90°/270° na matriz — sem isso o valor bruto do arquivo sai
 * invertido).
 */
function parseTkhd(buf: Buffer, start: number, end: number): { width: number; height: number } | null {
  if (end - start < 4) return null;
  const version = buf.readUInt8(start);
  const fixedBlockSize = version === 1 ? 8 + 8 + 4 + 4 + 8 : 4 + 4 + 4 + 4 + 4;
  const afterFixed = start + 4 + fixedBlockSize;
  const matrixOffset = afterFixed + 8 + 2 + 2 + 2 + 2;
  const widthOffset = matrixOffset + 36;
  const heightOffset = widthOffset + 4;
  if (heightOffset + 4 > end) return null;

  const readFixed1616 = (o: number) => buf.readInt32BE(o) / 65536;

  let width = readFixed1616(widthOffset);
  let height = readFixed1616(heightOffset);

  const a = Math.round(readFixed1616(matrixOffset));
  const b = Math.round(readFixed1616(matrixOffset + 4));
  const c = Math.round(readFixed1616(matrixOffset + 12));
  const d = Math.round(readFixed1616(matrixOffset + 16));
  const isRotated90or270 = a === 0 && d === 0 && Math.abs(b) === 1 && Math.abs(c) === 1;
  if (isRotated90or270) [width, height] = [height, width];

  width = Math.round(width);
  height = Math.round(height);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * Extrai a proporção real (já com rotação aplicada) de um vídeo MP4/MOV a
 * partir do `moov > trak > tkhd`, sem depender de ffmpeg — resolve o vídeo
 * chegando "quadrado" no Telegram antes de abrir: sem `width`/`height`
 * explícitos no `sendVideo`, o Bot API não sabe a proporção real do arquivo
 * e o app mostra uma miniatura genérica até o vídeo ser baixado de fato.
 * Retorna `null` (sem lançar) pra qualquer container que não seja
 * ISO-BMFF/QuickTime (ex: webm) — nesses casos o envio segue sem os campos,
 * como já era antes desta função existir.
 */
export function probeMp4VideoDimensions(buf: Buffer): { width: number; height: number } | null {
  try {
    const top = readBoxes(buf, 0, buf.length);
    const moov = top.find((b) => b.type === "moov");
    if (!moov) return null;

    let best: { width: number; height: number } | null = null;
    for (const trak of readBoxes(buf, moov.start, moov.end).filter((b) => b.type === "trak")) {
      const tkhd = readBoxes(buf, trak.start, trak.end).find((b) => b.type === "tkhd");
      if (!tkhd) continue;
      const dims = parseTkhd(buf, tkhd.start, tkhd.end);
      if (!dims) continue;
      // Track de áudio também tem tkhd, mas com width/height = 0 — a de
      // maior área é a trilha de vídeo.
      if (!best || dims.width * dims.height > best.width * best.height) best = dims;
    }
    return best;
  } catch {
    return null;
  }
}
