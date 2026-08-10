import path from "node:path";

export function normalizePath(value: string): string {
  return value.replaceAll(path.sep, "/").replace(/^\.\//, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function expandBraces(pattern: string): string[] {
  const match = pattern.match(/\{([^{}]+)\}/);
  if (!match || match.index === undefined) return [pattern];
  const before = pattern.slice(0, match.index);
  const after = pattern.slice(match.index + match[0].length);
  return match[1]!.split(",").flatMap((part) => expandBraces(`${before}${part}${after}`));
}

/**
 * Compiled patterns, keyed by the pattern text.
 *
 * A pattern compiles to the same expression every time, so the cache cannot go
 * stale: the mapping is pure, and it depends on no snapshot. It is worth having
 * because matching is the hot path — `matchesAny` compiles once per pattern per
 * file, and a Mechanism list checked against a thousand-file snapshot compiled
 * the same handful of patterns a thousand times.
 */
const COMPILED = new Map<string, RegExp>();

export function globToRegExp(pattern: string): RegExp {
  const cached = COMPILED.get(pattern);
  if (cached) return cached;
  const compiled = compileGlob(pattern);
  COMPILED.set(pattern, compiled);
  return compiled;
}

function compileGlob(pattern: string): RegExp {
  const normalized = normalizePath(pattern);
  let output = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index] ?? "";
    const next = normalized[index + 1];
    if (current === "*" && next === "*") {
      const following = normalized[index + 2];
      if (following === "/") {
        output += "(?:.*/)?";
        index += 2;
      } else {
        output += ".*";
        index += 1;
      }
      continue;
    }
    if (current === "*") {
      output += "[^/]*";
      continue;
    }
    if (current === "?") {
      output += "[^/]";
      continue;
    }
    output += escapeRegex(current);
  }
  output += "$";
  return new RegExp(output);
}

export function matchesGlob(value: string, pattern: string): boolean {
  return expandBraces(pattern).some((item) => globToRegExp(item).test(normalizePath(value)));
}

export function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesGlob(value, pattern));
}
