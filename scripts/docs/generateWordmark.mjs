import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Outline the wordmark; no font files or runtime dependencies ship with the SVG.
// 将字标转为路径；SVG 不包含字体文件或运行时依赖。
const [fontPath, fontkitPath] = process.argv.slice(2);
if (!fontPath || !fontkitPath) throw new Error("Usage: node generateWordmark.mjs <font.ttf> <fontkit-module>");
const fontkit = createRequire(import.meta.url)(fontkitPath);
const font = fontkit.openSync(fontPath);
const layout = font.layout("SessionBar");
let penX = 0;
let penY = 0;
let minX = Infinity;
let minY = Infinity;
let maxX = -Infinity;
let maxY = -Infinity;
const paths = layout.glyphs.map((glyph, index) => {
  const position = layout.positions[index];
  const path = glyph.path.scale(1, -1).translate(penX + position.xOffset, -penY - position.yOffset);
  const box = path.bbox;
  minX = Math.min(minX, box.minX);
  minY = Math.min(minY, box.minY);
  maxX = Math.max(maxX, box.maxX);
  maxY = Math.max(maxY, box.maxY);
  penX += position.xAdvance;
  penY += position.yAdvance;
  return path.toSVG();
});
const scale = Math.min(940 / (maxX - minX), 200 / (maxY - minY));
const x = (1080 - (maxX - minX) * scale) / 2 - minX * scale;
const y = (280 - (maxY - minY) * scale) / 2 - minY * scale;
const colors = ["#cf655b", "#db6455", "#c8a34e", "#dda516", "#52b985", "#209a67", "#36b5b8", "#608ac7", "#ac65ad", "#bd619e"];
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 280" role="img" aria-labelledby="title description">
  <title id="title">SessionBar</title>
  <desc id="description">Rainbow italic script wordmark. AI CLI Session Monitor.</desc>
  <metadata>Outlined with Lobster Two Bold Italic by Pablo Impallari and Igino Marini. Font source: https://github.com/google/fonts/tree/main/ofl/lobstertwo (SIL Open Font License 1.1). No font embedded.</metadata>
  <defs>
    <linearGradient id="rainbow" gradientUnits="userSpaceOnUse" x1="${minX}" y1="0" x2="${maxX}" y2="0">
${colors.map((color, index) => `      <stop offset="${(index / (colors.length - 1) * 100).toFixed(2)}%" stop-color="${color}"/>`).join("\n")}
    </linearGradient>
  </defs>
  <path fill="url(#rainbow)" transform="translate(${x.toFixed(3)} ${y.toFixed(3)}) scale(${scale.toFixed(6)})" d="${paths.join(" ")}"/>
</svg>
`;
writeFileSync(fileURLToPath(new URL("../../docs/images/sessionbar-wordmark.svg", import.meta.url)), svg);
