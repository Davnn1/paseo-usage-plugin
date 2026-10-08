import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const GEMINI_DIR = `${process.env.HOME}/.gemini`;

/**
 * Gemini CLI stores usage only as protobuf (*.pb) spikes under ~/.gemini.
 * There is no stable documented text/JSON schema for them, so this plugin does
 * not parse them: the backend is reported as no_data_source instead of guessing.
 */
export function probeGemini(dir: string = GEMINI_DIR): {
  status: "no_data_source" | "error";
  detail?: string;
} {
  try {
    if (!existsSync(dir)) return { status: "no_data_source", detail: "~/.gemini not found" };
    let sawPb = false;
    const walk = (current: string, depth: number) => {
      if (depth > 6 || sawPb) return;
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) walk(join(current, entry.name), depth + 1);
        else if (entry.name.endsWith(".pb")) sawPb = true;
      }
    };
    walk(dir, 0);
    return {
      status: "no_data_source",
      detail: sawPb
        ? "local store terenkripsi (conversations *.pb, magic bytes 84 94 aa 8c; protoc --decode_raw gagal)"
        : "no machine-readable usage data found",
    };
  } catch (error) {
    return { status: "error", detail: String(error) };
  }
}
