import { describe, it, expect } from "vitest";
import { probeMp4VideoDimensions } from "./videoProbe.js";

function fixed1616(n: number): number {
  return Math.round(n * 65536);
}

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, "ascii");
  return Buffer.concat([header, payload]);
}

function buildMatrix(rotate90: boolean): Buffer {
  const vals = rotate90 ? [0, 1, 0, -1, 0, 0, 0, 0, 1] : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const buf = Buffer.alloc(36);
  vals.forEach((v, i) => buf.writeInt32BE(fixed1616(v), i * 4));
  return buf;
}

function buildTkhdPayload(width: number, height: number, rotate90: boolean): Buffer {
  const widthBuf = Buffer.alloc(4);
  widthBuf.writeInt32BE(fixed1616(width), 0);
  const heightBuf = Buffer.alloc(4);
  heightBuf.writeInt32BE(fixed1616(height), 0);
  return Buffer.concat([
    Buffer.alloc(4), // version(0) + flags
    Buffer.alloc(20), // creation/modification/track_ID/reserved/duration (v0)
    Buffer.alloc(8), // reserved
    Buffer.alloc(2), // layer
    Buffer.alloc(2), // alternate_group
    Buffer.alloc(2), // volume
    Buffer.alloc(2), // reserved
    buildMatrix(rotate90),
    widthBuf,
    heightBuf,
  ]);
}

function buildMp4(width: number, height: number, rotate90: boolean): Buffer {
  const tkhd = box("tkhd", buildTkhdPayload(width, height, rotate90));
  const trak = box("trak", tkhd);
  return box("moov", trak);
}

describe("probeMp4VideoDimensions", () => {
  it("lê width/height do tkhd de um vídeo sem rotação", () => {
    expect(probeMp4VideoDimensions(buildMp4(1920, 1080, false))).toEqual({ width: 1920, height: 1080 });
  });

  it("inverte width/height quando o vídeo foi gravado vertical (rotação 90° na matriz)", () => {
    expect(probeMp4VideoDimensions(buildMp4(1920, 1080, true))).toEqual({ width: 1080, height: 1920 });
  });

  it("retorna null pra um buffer que não é um container MP4/MOV válido", () => {
    expect(probeMp4VideoDimensions(Buffer.from("não é um vídeo"))).toBeNull();
  });
});
