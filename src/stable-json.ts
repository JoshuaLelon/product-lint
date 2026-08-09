import { createHash } from "node:crypto";

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      const item = input[key];
      if (item !== undefined) output[key] = normalize(item);
    }
    return output;
  }
  return value;
}

export function stableStringify(value: unknown, spacing = 0): string {
  return JSON.stringify(normalize(value), null, spacing);
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function digest(value: unknown, version: string): string {
  return `sha256:${version}:${sha256(stableStringify(value))}`;
}
