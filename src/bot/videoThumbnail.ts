import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";

/**
 * Gera a miniatura (thumbnail) real de um vídeo via ffmpeg. O Telegram diz
 * que gera a própria miniatura quando nenhuma é enviada, mas essa geração
 * automática falha silenciosamente pra vídeos com o container não otimizado
 * pra streaming (moov no fim do arquivo) — comum em exports de editores web
 * como o Clideo — e cai num placeholder genérico em vez da proporção real
 * do vídeo. Mandar a miniatura explicitamente evita depender disso.
 * Retorna `null` (sem lançar) se o ffmpeg não estiver disponível ou falhar
 * — nesse caso o envio segue sem thumbnail, como já era antes.
 */
export async function extractVideoThumbnail(buffer: Buffer): Promise<Buffer | null> {
  if (!ffmpegPath) return null;
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "dgbot-thumb-"));
    const inputPath = join(dir, "input");
    const outputPath = join(dir, "thumb.jpg");
    await writeFile(inputPath, buffer);

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath as unknown as string, [
        "-y",
        "-i",
        inputPath,
        "-ss",
        "00:00:00.1",
        "-frames:v",
        "1",
        "-vf",
        "scale=w=320:h=320:force_original_aspect_ratio=decrease",
        "-q:v",
        "4",
        outputPath,
      ]);
      proc.on("error", reject);
      proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg saiu com código ${code}`))));
    });

    return await readFile(outputPath);
  } catch (err) {
    console.error("[videoThumbnail] falha ao gerar miniatura do vídeo, seguindo sem thumbnail", err);
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
