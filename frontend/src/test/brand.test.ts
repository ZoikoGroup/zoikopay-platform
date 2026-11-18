import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const tokens = readFileSync(join(__dirname, '../styles/tokens.css'), 'utf8');
const token = (name: string) => {
  const value = tokens.match(new RegExp('--' + name + ':\\s*(#[0-9a-f]{6})', 'i'))?.[1];
  if (!value) throw new Error('Missing brand token: ' + name);
  return value;
};
function luminance(hex: string) {
  const rgb = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return rgb[0]! * .2126 + rgb[1]! * .7152 + rgb[2]! * .0722;
}
const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);

describe('approved Zoiko Pay brand', () => {
  it('uses light surfaces and navy/green brand accents', () => {
    expect(tokens).toContain('color-scheme: light');
    expect(token('navy')).toBe('#031b36');
    expect(token('brand')).toBe('#008333');
    expect(token('surface-1')).toBe('#ffffff');
  });
  it('keeps body, secondary and muted text readable on white and page surfaces', () => {
    for (const foreground of ['text', 'text-2', 'text-3']) for (const background of ['surface-1', 'bg']) {
      expect(contrast(token(foreground), token(background)), foreground + '/' + background).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(token('brand'), token('white'))).toBeGreaterThanOrEqual(4.5);
  });
});
