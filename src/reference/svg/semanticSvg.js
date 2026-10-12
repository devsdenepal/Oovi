/**
 * Semantic SVG generator.
 *
 * Produces a clean, grouped, human-readable SVG from a ReferenceDesignAnalysis:
 * background + palette legend, layout regions, text/image/shape/decoration
 * elements. This is NOT meant for pixel-perfect reproduction - it is a
 * semantic visualization used in the debug UI and by future SVG export.
 */

function escXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeId(value) {
  return String(value || "x").replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function renderDotGrid(d, width, height) {
  const spacing = Math.max(2, d.spacing || 12);
  const radius = Math.max(1, d.radius || 1);
  const size = 4;
  const cols = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const cx = d.x - ((size - 1) / 2) * spacing + c * spacing;
      const cy = d.y - ((size - 1) / 2) * spacing + r * spacing;
      if (cx < 0 || cy < 0 || cx > width || cy > height) continue;
      cols.push(
        `  <circle cx="${Math.round(cx)}" cy="${Math.round(cy)}" r="${radius}" fill="${d.color}" opacity="0.8"/>`,
      );
    }
  }
  return cols.join("\n");
}

/**
 * @param {import("./analysisTypes").ReferenceDesignAnalysis} analysis
 * @returns {string}
 */
export function buildSemanticSvg(analysis) {
  const { width, height } = analysis.canvas;
  const p = analysis.palette;
  const parts = [];

  parts.push(
    `<!-- Semantic SVG: ${escXml(analysis.source.fileName || "reference")} (${width}x${height}) -->`,
  );
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="sans-serif">`,
  );
  parts.push(`  <rect id="background" x="0" y="0" width="${width}" height="${height}" fill="${p.background}" />`);

  // --- palette legend (bottom-left swatch row) ---
  const legendFont = Math.max(10, Math.round(height * 0.012));
  const swatch = Math.max(8, Math.round(width * 0.02));
  const colors = [...new Set([p.background, ...p.dominant.map((d) => d.hex), p.accent])].slice(0, 7);
  parts.push(`  <g id="palette-legend" font-family="monospace" font-size="${legendFont}" fill="${p.text}">`);
  colors.forEach((hex, i) => {
    const x = Math.round(swatch * 0.5 + i * (swatch + swatch * 0.3));
    const y = Math.round(height - swatch * 1.3);
    parts.push(
      `    <rect x="${x}" y="${y}" width="${swatch}" height="${swatch}" fill="${hex}" stroke="#9a9aa6" stroke-width="${Math.max(1, Math.round(width * 0.0015))}"/>`,
    );
    parts.push(`    <text x="${Math.round(x + swatch / 2)}" y="${Math.round(y - 3)}" text-anchor="middle" font-size="${Math.max(8, legendFont - 2)}">${hex}</text>`);
  });
  parts.push(`  </g>`);

  // --- layout regions ---
  for (const region of analysis.layout.regions) {
    const id = safeId(`region-${region.id}`);
    parts.push(`  <g id="${id}" data-role="${region.role}">`);
    parts.push(
      `    <rect x="${region.x}" y="${region.y}" width="${region.width}" height="${region.height}" fill="#000" opacity="0.05"/>`,
    );
    parts.push(
      `    <rect x="${region.x}" y="${region.y}" width="${region.width}" height="${region.height}" fill="none" stroke="${p.accent}" stroke-width="${Math.max(1, Math.round(width * 0.002))}" stroke-dasharray="${Math.round(width * 0.012)} ${Math.round(width * 0.009)}"/>`,
    );
    const labelX = region.x + Math.round(width * 0.008);
    const labelY = region.y + Math.round(width * 0.022);
    parts.push(
      `    <text x="${labelX}" y="${labelY}" font-family="monospace" font-size="${legendFont}" fill="${p.text}">${escXml(region.role)}</text>`,
    );
    parts.push(`  </g>`);
  }

  // --- text elements ---
  for (const t of analysis.elements.text) {
    const id = safeId(t.id);
    parts.push(`  <g id="text-${id}" data-role="text">`);
    parts.push(
      `    <rect x="${t.x}" y="${t.y}" width="${t.width}" height="${t.height}" fill="${t.color}" opacity="0.55"/>`,
    );
    if (t.width > 12 && t.height > 8) {
      const label = String(t.content || "TEXT").slice(0, 40) || "TEXT";
      const fs = Math.max(8, Math.min(t.height * 0.72, t.width * 0.9));
      const align = t.alignment === "center" ? "middle" : t.alignment === "right" ? "end" : "start";
      const ax =
        align === "middle"
          ? t.x + t.width / 2
          : align === "end"
            ? t.x + t.width - 2
            : t.x + 4;
      parts.push(
        `    <text x="${ax}" y="${Math.round(t.y + t.height * 0.72)}" text-anchor="${align}" font-family="sans-serif" font-size="${Math.round(Math.min(fs, 24))}" fill="#000">${escXml(label)}</text>`,
      );
    }
    parts.push(`  </g>`);
  }

  // --- image areas ---
  for (const im of analysis.elements.images) {
    const id = safeId(im.id);
    parts.push(`  <g id="image-${id}" data-role="image">`);
    parts.push(
      `    <rect x="${im.x}" y="${im.y}" width="${im.width}" height="${im.height}" fill="${p.primary}" opacity="0.14"/>`,
    );
    parts.push(
      `    <rect x="${im.x}" y="${im.y}" width="${im.width}" height="${im.height}" fill="none" stroke="${p.primary}"/>`,
    );
    if (im.width > 30 && im.height > 24) {
      parts.push(
        `    <text x="${Math.round(im.x + im.width / 2)}" y="${Math.round(im.y + im.height / 2)}" text-anchor="middle" font-family="monospace" font-size="${Math.max(10, Math.round(im.height * 0.12))}" fill="${p.primary}">IMAGE</text>`,
      );
    }
    parts.push(`  </g>`);
  }

  // --- shapes ---
  for (const s of analysis.elements.shapes) {
    const id = safeId(`shape-${s.id}`);
    if (s.type === "circle" && s.radius) {
      parts.push(
        `  <circle id="${id}" data-role="${s.role}" cx="${Math.round(s.x + s.radius)}" cy="${Math.round(s.y + s.radius)}" r="${Math.round(s.radius)}" fill="${s.color}" opacity="0.7"/>`,
      );
    } else if (s.type === "line") {
      parts.push(
        `  <line id="${id}" data-role="${s.role}" x1="${Math.round(s.x)}" y1="${Math.round(s.y + s.height / 2)}" x2="${Math.round(s.x + s.width)}" y2="${Math.round(s.y + s.height / 2)}" stroke="${s.color}" stroke-width="${Math.max(1, s.height)}" opacity="0.7"/>`,
      );
    } else {
      parts.push(
        `  <rect id="${id}" data-role="${s.role}" x="${Math.round(s.x)}" y="${Math.round(s.y)}" width="${Math.round(s.width)}" height="${Math.round(s.height)}" rx="${Math.round(s.cornerRadius || 0)}" fill="${s.color}" opacity="0.7"/>`,
      );
    }
  }

  // --- decorations ---
  for (const d of analysis.elements.decorations) {
    const id = safeId(`deco-${d.id}`);
    if (d.type === "dot_grid") {
      parts.push(`  <g id="${id}" data-role="decoration" data-kind="dot_grid">`);
      parts.push(renderDotGrid(d, width, height));
      parts.push(`  </g>`);
    } else if (d.type === "divider") {
      parts.push(
        `  <line id="${id}" data-role="decoration" x1="${Math.round(d.x)}" y1="${Math.round(d.y + d.height / 2)}" x2="${Math.round(d.x + d.width)}" y2="${Math.round(d.y + d.height / 2)}" stroke="${d.color}" stroke-width="${Math.max(1, d.height)}" opacity="0.5"/>`,
      );
    } else {
      parts.push(
        `  <rect id="${id}" data-role="decoration" x="${Math.round(d.x)}" y="${Math.round(d.y)}" width="${Math.max(1, d.width)}" height="${Math.max(1, d.height)}" fill="${d.color}" opacity="0.6"/>`,
      );
    }
  }

  parts.push(`</svg>`);
  return parts.join("\n");
}