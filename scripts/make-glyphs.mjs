// Writes the original list-view icons to src/app/glyphs/*.svg. The file names match the ids the
// view references (see ICONS in src/app/things-list.html). Run `node scripts/make-glyphs.mjs`,
// then `npm run build:app`. These are simple strokes drawn for this project; they are MIT licensed
// with the rest of the repo and are not taken from any other application.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../src/app/glyphs/", import.meta.url));
mkdirSync(dir, { recursive: true });
const stroke = (c, w = 1.8) => `fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;
const svg = (vb, inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${inner}</svg>\n`;
const write = (name, vb, inner) => writeFileSync(dir + name + ".svg", svg(vb, inner));
const both = (name, inner) => { write(name, "0 0 24 24", inner); write(`${name}-Dark`, "0 0 24 24", inner); };

// Source icons: coloured so they read on light and dark backgrounds, so the -Dark file is identical.
both("Source-Today", `<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9 6.8 19.7l1-5.9L3.5 9.7l5.9-.8z" fill="#f5b800" stroke="#f5b800" stroke-width="1.2" stroke-linejoin="round"/>`);
both("Source-Inbox", `<path d="M4 13l2.2-7.5h11.6L20 13v5.5H4z" ${stroke("#2f7df6")}/><path d="M4 13h4.5a3.5 3.5 0 007 0H20" ${stroke("#2f7df6")}/>`);
both("Source-Upcoming", `<rect x="4" y="5.5" width="16" height="14" rx="2.5" ${stroke("#e5484d")}/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" ${stroke("#e5484d")}/>`);
both("Source-Anytime", `<path d="M12 4l8 4-8 4-8-4z" ${stroke("#14a39a")}/><path d="M4 12l8 4 8-4M4 16l8 4 8-4" ${stroke("#14a39a")}/>`);
both("Source-Someday", `<rect x="4" y="7" width="16" height="12" rx="2" ${stroke("#c49a1a")}/><path d="M4 11h16M10 14.5h4" ${stroke("#c49a1a")}/>`);
both("Source-Evening", `<path d="M19 14.5A7.5 7.5 0 019.5 5a7.5 7.5 0 109.5 9.5z" fill="#5b5bd6"/>`);
write("Source-Logbook", "0 0 24 24", `<rect x="5" y="4" width="14" height="16" rx="2.5" ${stroke("#3fae5a")}/><path d="M8.5 9.5l1.7 1.7 3.3-3.4M8.5 15.5h7" ${stroke("#3fae5a")}/>`);

// Checkboxes: 28px squares, grey outline when open, green when done.
both("Checkbox-Regular", `<rect x="3.5" y="3.5" width="17" height="17" rx="4.5" ${stroke("#9aa0a8", 1.6)}/>`);
both("Checkbox-Completed", `<rect x="3.5" y="3.5" width="17" height="17" rx="4.5" fill="#3fae5a"/><path d="M8 12.3l2.8 2.8L16.3 9.2" ${stroke("#fff", 2)}/>`);

// Small task markers tinted by CSS through currentColor.
write("Task-Deadline-Template", "0 0 24 24", `<path d="M6 21V4M6 5h11l-2.5 3.5L17 12H6" ${stroke("currentColor", 2)}/>`);
write("Task-DeadlineOverdue-Template", "0 0 24 24", `<path d="M6 21V4M6 5h11l-2.5 3.5L17 12H6" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`);
write("Task-Checklist-Template", "0 0 24 24", `<path d="M5 7h2M5 12h2M5 17h2M10 7h9M10 12h9M10 17h9" ${stroke("currentColor", 2)}/>`);
write("Task-Repeat-Template", "0 0 24 24", `<path d="M17 4l3 3-3 3M20 7H8a4 4 0 00-4 4v1M7 20l-3-3 3-3M4 17h12a4 4 0 004-4v-1" ${stroke("currentColor", 2)}/>`);

// Project pie sprite: 11 x 11 cells of 32px, cell i is the pie filled i/120 of the way round.
let cells = "";
for (let i = 0; i < 121; i++) {
  const cx = (i % 11) * 32 + 16, cy = Math.floor(i / 11) * 32 + 16, r = 11;
  const f = i / 120;
  let wedge = "";
  if (f >= 1) wedge = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor"/>`;
  else if (f > 0) {
    const a = f * 2 * Math.PI, x = cx + r * Math.sin(a), y = cy - r * Math.cos(a);
    wedge = `<path d="M${cx} ${cy}V${cy - r}A${r} ${r} 0 ${f > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}z" fill="currentColor"/>`;
  }
  cells += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="currentColor" stroke-width="1.6"/>${wedge}`;
}
write("Project-Pies-400", "0 0 352 352", cells);
