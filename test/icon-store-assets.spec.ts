// @vitest-environment node

/**
 * 商店档位资产（`assets/store/`）的判据。
 *
 * 档位按合作伙伴中心列出的那几档出：Extension logo 是 1:1（推荐 300×300、下限 128×128），
 * Small promotional tile 必须 440×280，Large promotional tile 的 PNG 必须 1400×560。
 *
 * 四件事要钉：
 *
 * 1. **位图自身**：尺寸、透明那一侧对不对（logo 四角透明、促销图整幅不透明）、颜色对不对。
 * 2. **SVG 与位图说的是同一个形状**：同一颗字标现在有多份表示（生成器里的解析式判定 /
 *    每份 SVG 里的 rect + path），手改任何一份只会让商店大图与工具栏图标分叉 ——
 *    那是品牌定案起就一直躲着的东西。所以这里不核"文件存在"，而是**从位图里量出包围盒**，
 *    再要求 SVG 写着的数落在量到的边上。
 * 3. **形状在各档之间是同一颗**：底板与字标的比例一致，量的是像素差而不是小数位
 *    （128 那一档"完全落在形状内"的像素本来就会少掉约 1px，按小数容差会假红）。
 * 4. **档位没漏进扩展包**：`public/icon/` 只放 manifest 会自动发现的那五档。
 *
 * 判据只读**产物**、不 import 生成脚本：换一台只 clone 源码的机器上那些工具不一定在，
 * 这个文件必须照跑。
 *
 * ⚠ 容差 1px（成对核边界）/ 2px（核比例）：位图边缘是 4x 超采样出来的覆盖率，
 *   半像素处 alpha 不满 255 是正常现象，所以核的是"SVG 的数落在实测边的 ±1 内"。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(process.cwd());
const STORE = join(ROOT, 'assets', 'store');

const BRAND: [number, number, number] = [0x35, 0x6d, 0x52];
const INK: [number, number, number] = [0xff, 0xff, 0xff];
const TINT: [number, number, number] = [0xe6, 0xf0, 0xeb];
const BRAND_HEX = '356d52';
const INK_HEX = 'ffffff';
const TINT_HEX = 'e6f0eb';

/** 促销图上那颗底板占图高的比例 —— 口味值，钉在这里，改它要连这里一起改。 */
const TILE_PLATE_RATIO = 0.72;
/** 1:1 那颗底板的圆角占边长的比例，同上。 */
const PLATE_RADIUS_RATIO = 0.235;

type Pixel = [number, number, number, number];
type Raster = { w: number; h: number; rgba: Uint8Array };

/** 四颗位图：尺寸与"透明那一侧"的期望。 */
const RASTERS = [
  { png: 'logo-300.png', w: 300, h: 300, opaque: false },
  { png: 'logo-128.png', w: 128, h: 128, opaque: false },
  { png: 'tile-440x280.png', w: 440, h: 280, opaque: true },
  { png: 'tile-1400x560.png', w: 1400, h: 560, opaque: true },
];

/**
 * 位图与**同尺寸**的矢量母版成对核。
 * logo-128 没有自己的 SVG：它与 manifest 用的那颗逐字节相同，由下面那条用例钉住。
 */
const PAIRS = [
  { png: 'logo-300.png', svg: 'icon.svg', rects: 1, opaque: false },
  { png: 'tile-440x280.png', svg: 'tile-440x280.svg', rects: 2, opaque: true },
  { png: 'tile-1400x560.png', svg: 'tile-1400x560.svg', rects: 2, opaque: true },
];

function decodePng(file: string): Raster {
  const bytes = readFileSync(join(STORE, file));
  expect(bytes.subarray(0, 8).toString('hex'), `${file} 的 PNG 签名`).toBe('89504e470d0a1a0a');
  const w = bytes.readUInt32BE(16);
  const h = bytes.readUInt32BE(20);
  expect(bytes.readUInt8(24), `${file} 位深`).toBe(8);
  expect(bytes.readUInt8(25), `${file} 颜色类型（6 = 真彩色带 alpha）`).toBe(6);
  expect(bytes.readUInt8(26), `${file} 压缩方法`).toBe(0);
  expect(bytes.readUInt8(27), `${file} filter 方法`).toBe(0);
  expect(bytes.readUInt8(28), `${file} 不许是隔行（interlace）`).toBe(0);

  const idat: Buffer[] = [];
  let at = 8;
  while (at < bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString('ascii');
    if (type === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + length));
    if (type === 'IEND') break;
    at += 12 + length; // 4 长度 + 4 类型 + data + 4 CRC
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    // 生成器只用 filter 0（None）；哪天换了 filter 这里要跟着改，所以钉住。
    expect(raw[y * (stride + 1)], `${file} 第 ${y} 行的 filter 字节`).toBe(0);
    rgba.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride);
  }
  return { w, h, rgba };
}

function pixel(r: Raster, x: number, y: number): Pixel {
  const i = (y * r.w + x) * 4;
  const take = (n: number | undefined): number => {
    if (n === undefined) throw new Error(`像素 ${x},${y} 越界`);
    return n;
  };
  return [take(r.rgba[i]), take(r.rgba[i + 1]), take(r.rgba[i + 2]), take(r.rgba[i + 3])];
}

const sameColor = (p: Pixel, c: [number, number, number]): boolean =>
  p[3] === 255 && p[0] === c[0] && p[1] === c[1] && p[2] === c[2];

const isPlate = (p: Pixel): boolean => sameColor(p, BRAND);
const isGlyph = (p: Pixel): boolean => sameColor(p, INK);

type Box = { x0: number; y0: number; x1: number; y1: number };

/**
 * 命中像素的包围盒，右开（x1/y1 = 最后命中 + 1）。
 * "命中"要求整像素是那个颜色，所以每条边最多比真实边界缩进 1px —— 容差按这个来定。
 */
function bbox(r: Raster, match: (p: Pixel) => boolean): Box {
  let x0 = -1;
  let y0 = -1;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < r.h; y += 1) {
    for (let x = 0; x < r.w; x += 1) {
      if (!match(pixel(r, x, y))) continue;
      if (x0 === -1 || x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y0 === -1 || y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x0 === -1) throw new Error('量不到目标区域（包围盒为空）');
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/** 一行（或一列）上白色字标的跨度 [start, end)，并要求它是一段连续的。 */
function run(r: Raster, axis: 'row' | 'col', fixed: number): [number, number] {
  const at = (i: number) => (axis === 'row' ? pixel(r, i, fixed) : pixel(r, fixed, i));
  let start = -1;
  let end = -1;
  let hits = 0;
  for (let i = 0; i < (axis === 'row' ? r.w : r.h); i += 1) {
    if (isGlyph(at(i))) {
      if (start === -1) start = i;
      end = i + 1;
      hits += 1;
    }
  }
  if (start === -1) throw new Error(`${axis} ${fixed} 上量不到白色字标`);
  // 上面按 min/max 取边，前提是这一行（列）上字标只有一段。断成两段就不成立了，
  // 所以把"连续"也核一次，而不是当成显然的事。
  expect(hits, `${axis} ${fixed}：白字标不是一段（${hits} 个像素 / 跨度 ${end - start}）`).toBe(end - start);
  return [start, end];
}

// --- SVG 侧：把 rect + path 上的数读回来 -------------------------------------

function grab(text: string, pattern: RegExp, what: string): string {
  const found = pattern.exec(text)?.[1];
  if (found === undefined) throw new Error(`SVG 里找不到${what}（模式 ${pattern.source}）`);
  return found;
}

type SvgRect = { x: number; y: number; w: number; h: number; rx: number; fill: string };

function parseRects(text: string): SvgRect[] {
  return [...text.matchAll(/<rect\b([^/>]*)\/>/g)].map((m) => {
    const attrs = m[1] ?? '';
    const num = (name: string): number => {
      const v = new RegExp(`\\b${name}="([\\d.]+)"`).exec(attrs)?.[1];
      return v === undefined ? 0 : Number(v);
    };
    const fill = new RegExp('\\bfill="#([0-9a-fA-F]{6})"').exec(attrs)?.[1]?.toLowerCase();
    if (fill === undefined) throw new Error(`rect 没有 fill：${attrs}`);
    return { x: num('x'), y: num('y'), w: num('width'), h: num('height'), rx: num('rx'), fill };
  });
}

type Svg = {
  w: number;
  h: number;
  rects: SvgRect[];
  plate: SvgRect;
  edges: {
    barLeft: number;
    barTop: number;
    barRight: number;
    barBottom: number;
    stemLeft: number;
    stemRight: number;
    stemBottom: number;
  };
  glyphFill: string;
};

function parseSvg(file: string): Svg {
  const text = readFileSync(join(STORE, file), 'utf8');
  const w = Number(grab(text, /<svg[^>]*\bwidth="([\d.]+)"/, '根元素的 width'));
  const h = Number(grab(text, /<svg[^>]*\bheight="([\d.]+)"/, '根元素的 height'));
  expect(grab(text, /viewBox="0 0 ([\d.]+) [\d.]+"/, 'viewBox 的宽'), 'viewBox 的宽应当等于 width')
    .toBe(String(w));
  expect(grab(text, /viewBox="0 0 [\d.]+ ([\d.]+)"/, 'viewBox 的高'), 'viewBox 的高应当等于 height')
    .toBe(String(h));

  const rects = parseRects(text);
  const plate = rects[rects.length - 1];
  if (!plate) throw new Error(`${file} 里没有 rect`);

  const d = grab(text, /d="([^"]+)"/, '字标路径 d');
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  expect(nums.length, `SVG 路径的数个数：${d}`).toBe(9);
  const [barLeft = NaN, barTop = NaN, barRight = NaN, barBottom = NaN, stemRight = NaN,
    stemBottom = NaN, stemLeft = NaN] = nums;
  const glyphFill = grab(text, /<path[^>]*fill="#([0-9a-fA-F]{6})"/, '字标的 fill').toLowerCase();
  return { w, h, rects, plate, edges: { barLeft, barTop, barRight, barBottom, stemLeft, stemRight, stemBottom }, glyphFill };
}

const cache = new Map<string, Raster>();
function rasterOf(file: string): Raster {
  let r = cache.get(file);
  if (!r) {
    r = decodePng(file);
    cache.set(file, r);
  }
  return r;
}

const within = (actual: number, expected: number, what: string, tolerance = 1) => {
  expect(Math.abs(actual - expected), `${what}：期望 ${expected}，实测量到 ${actual}`).toBeLessThanOrEqual(tolerance);
};

describe('商店档位资产（assets/store/）', () => {
  it('档位齐全，且没有一颗漏进 public/icon/（那里会被当成 manifest 的 icons 键）', () => {
    expect(readdirSync(STORE).sort()).toEqual([
      'icon.svg',
      'logo-128.png',
      'logo-300.png',
      'tile-1400x560.png',
      'tile-1400x560.svg',
      'tile-440x280.png',
      'tile-440x280.svg',
    ]);
    expect(
      readdirSync(join(ROOT, 'public', 'icon'))
        .map((f) => Number(f.replace(/\.png$/, '')))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b),
    ).toEqual([16, 32, 48, 96, 128]);
  });

  it('logo-128.png 与 manifest 用的那颗逐字节相同（同一颗图，表单里传哪份都一样）', () => {
    expect(readFileSync(join(STORE, 'logo-128.png')).equals(
      readFileSync(join(ROOT, 'public', 'icon', '128.png')),
    )).toBe(true);
  });

  for (const asset of RASTERS) {
    it(`${asset.png}：尺寸对、透明/满版那一侧对、颜色对`, () => {
      const r = rasterOf(asset.png);
      expect([r.w, r.h], 'IHDR 的尺寸').toEqual([asset.w, asset.h]);
      const corners: Array<[number, number]> = [
        [0, 0], [r.w - 1, 0], [0, r.h - 1], [r.w - 1, r.h - 1],
      ];
      for (const [x, y] of corners) {
        const p = pixel(r, x, y);
        if (asset.opaque) {
          expect(sameColor(p, TINT), `角 ${x},${y} 应当是满版浅底`).toBe(true);
        } else {
          expect(p[3], `角 ${x},${y} 的 alpha（1:1 那颗要留透明）`).toBe(0);
        }
      }
      const plate = bbox(r, isPlate);
      const glyph = bbox(r, isGlyph);
      expect(plate.x1 - plate.x0, `${asset.png} 底板宽度`).toBeGreaterThan(0);
      expect(glyph.x1 - glyph.x0, `${asset.png} 字标宽度`).toBeGreaterThan(0);
      if (asset.opaque) {
        // 满版那张不留一个半透明像素：底板边缘的过渡是在浅底上算出来的，不是靠 alpha。
        let seeThrough = 0;
        for (let y = 0; y < r.h; y += 1) {
          for (let x = 0; x < r.w; x += 1) if (pixel(r, x, y)[3] !== 255) seeThrough += 1;
        }
        expect(seeThrough, `${asset.png} 里不该有半透明像素`).toBe(0);
      }
    });
  }

  for (const pair of PAIRS) {
    it(`${pair.svg} 与 ${pair.png} 说的是同一个形状（容差 1px）`, () => {
      const r = rasterOf(pair.png);
      const svg = parseSvg(pair.svg);
      const e = svg.edges;

      expect(svg.rects.length, `${pair.svg} 的层数（rect 个数）`).toBe(pair.rects);
      expect(svg.glyphFill, '字标 fill 不是白').toBe(INK_HEX);
      expect(svg.plate.fill, '底板 fill 与位图不是同一个绿').toBe(BRAND_HEX);
      if (pair.rects === 2) {
        expect(svg.rects[0]?.fill, '满版浅底的颜色不是那个浅青').toBe(TINT_HEX);
      }
      expect([svg.w, svg.h], 'SVG 与位图不同尺寸，两者不该拿来互相比').toEqual([r.w, r.h]);

      const plate = bbox(r, isPlate);
      within(plate.x0, svg.plate.x, '底板左边');
      within(plate.y0, svg.plate.y, '底板顶边');
      within(plate.x1, svg.plate.x + svg.plate.w, '底板右边');
      within(plate.y1, svg.plate.y + svg.plate.h, '底板底边');

      const glyph = bbox(r, isGlyph);
      within(glyph.x0, e.barLeft, '横笔左边');
      within(glyph.x1, e.barRight, '横笔右边');
      within(glyph.y0, e.barTop, '字标顶边');
      within(glyph.y1, e.stemBottom, '字标底边');

      const barRow = run(r, 'row', Math.round((e.barTop + e.barBottom) / 2));
      within(barRow[0], e.barLeft, '横笔左边（按行量）');
      within(barRow[1], e.barRight, '横笔右边（按行量）');
      const stemRow = run(r, 'row', Math.round((e.barBottom + e.stemBottom) / 2));
      within(stemRow[0], e.stemLeft, '竖笔左边');
      within(stemRow[1], e.stemRight, '竖笔右边');
      const col = run(r, 'col', Math.round((e.barLeft + e.barRight) / 2));
      within(col[0], e.barTop, '字标顶边（按列量）');
      within(col[1], e.stemBottom, '字标底边（按列量）');

      // 圆角：rx 既要对得上底板的边长，也要落在位图真量得到的那道弧上。
      // （促销图那两档曾经在这里漏过一次：rx 被当成坐标算，多加了一次底板落点。）
      const radius = svg.plate.rx;
      within(radius, svg.plate.w * PLATE_RADIUS_RATIO, `${pair.svg} 的 rx 与底板边长的比例`);
      const cx = svg.plate.x + radius;
      const cy = svg.plate.y + radius;
      // delta > 0 = 朝弧心靠近（图形之内），delta < 0 = 越过弧线（图形之外）。
      const probe = (delta: number): Pixel => pixel(
        r,
        Math.round(cx - (radius - delta) / Math.SQRT2),
        Math.round(cy - (radius - delta) / Math.SQRT2),
      );
      const outside = probe(-4);
      expect(isPlate(probe(4)), `${pair.svg} 的 rx 之内应当是底板`).toBe(true);
      if (pair.opaque) {
        expect(sameColor(outside, TINT), `${pair.svg} 的 rx 之外应当是浅底`).toBe(true);
      } else {
        expect(outside[3], `${pair.svg} 的 rx 之外应当是透明的`).toBe(0);
      }
    });
  }

  it('各档之间是同一颗字标：底板与字标的比例一致（±2px）', () => {
    for (const asset of RASTERS) {
      const r = rasterOf(asset.png);
      const plate = bbox(r, isPlate);
      const glyph = bbox(r, isGlyph);
      const plateW = plate.x1 - plate.x0;
      const plateH = plate.y1 - plate.y0;
      const canvasH = r.h;

      const wantPlateH = asset.opaque ? canvasH * TILE_PLATE_RATIO : canvasH;
      within(plateH, wantPlateH, `${asset.png} 底板高度`, 2);
      within(plateW, wantPlateH, `${asset.png} 底板是正方形（宽=高）`, 2);
      within(glyph.y1 - glyph.y0, plateH * 0.6, `${asset.png} 字标高度 = 底板的 0.60`, 2);
      within(glyph.x1 - glyph.x0, plateW * 0.52, `${asset.png} 横笔宽度 = 底板的 0.52`, 2);
      // 竖笔宽度与横笔厚度是同一个数（0.155），这是"同一颗"最省事的一条交叉核对。
      const stemRow = run(r, 'row', Math.round((glyph.y0 + glyph.y1) / 2) + 1);
      within(stemRow[1] - stemRow[0], plateW * 0.155, `${asset.png} 竖笔粗细`, 2);
    }
  });
});
