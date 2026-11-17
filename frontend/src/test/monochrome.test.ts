import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Enforces the strict two-colour rule: every colour literal in styles and
 * components must be pure black or pure white (optionally with opacity).
 */
const SRC = join(__dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "test" || name === "assets" ? [] : files(p);
    return /\.(css|tsx|ts)$/.test(name) ? [p] : [];
  });
}

const HEX = /#([0-9a-fA-F]{3,8})\b/g;
const RGB = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g;
const HSL = /hsla?\(|oklch\(|lab\(|lch\(/;
const NAMED = /(?<![\w-])(red|blue|green|yellow|orange|purple|pink|cyan|magenta|teal|navy|gray|grey|gold|violet|indigo|lime|maroon|olive|silver|brown)(?![\w-])/;

function isMono(hex: string): boolean {
  const h = hex.toLowerCase();
  const rgb = h.length <= 4 ? h.slice(0, 3) : h.slice(0, 6);
  return /^(0{3}|f{3}|0{6}|f{6})$/.test(rgb);
}

describe("strict black-and-white palette", () => {
  const all = files(SRC);

  it("finds source files to check", () => {
    expect(all.some((f) => f.endsWith("tokens.css"))).toBe(true);
    expect(all.length).toBeGreaterThan(20);
  });

  for (const file of all) {
    it(`${file.replace(SRC, "src")} uses only black and white`, () => {
      const text = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "") // CSS/JS block comments
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/url\("data:image\/svg\+xml[^"]*"\)/g, (m) => m.replace(/stroke='white'/g, "")); // inline chevron uses white
      const bad: string[] = [];
      for (const m of text.matchAll(HEX)) {
        // Ignore ids like #root or #main in selectors
        if (/^[0-9a-fA-F]+$/.test(m[1]!) && [3, 4, 6, 8].includes(m[1]!.length) && !isMono(m[1]!)) bad.push(m[0]);
      }
      for (const m of text.matchAll(RGB)) {
        const [r, g, b] = [m[1], m[2], m[3]].map(Number);
        if (!((r === 0 && g === 0 && b === 0) || (r === 255 && g === 255 && b === 255))) bad.push(m[0]);
      }
      if (HSL.test(text)) bad.push("hsl/oklch/lab colour function");
      if (file.endsWith(".css")) {
        const named = text.match(NAMED);
        if (named) bad.push(named[0]);
      }
      expect(bad, `non-monochrome colours in ${file}`).toEqual([]);
    });
  }
});
