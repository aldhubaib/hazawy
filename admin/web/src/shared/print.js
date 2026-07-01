// Canonical print specification, straight from the printing press.
//
// This is the single source of truth for the physical geometry of a printed
// sheet. It is pure, isomorphic JavaScript (no Node, DOM, or React) so it can be
// imported by BOTH the React client (to size the page canvas) and the Express
// server (to render print-ready files), and the two can never drift.
//
// All dimensions are in PIXELS at 300 DPI — the exact numbers the press gave us.
//
// The geometry nests as three boxes (outer to inner), all centered, so the two
// halves of each layer meet exactly at the page center (50%):
//   1. PAGE_AREA  — the full sheet / media (includes grip + bleed).
//   2. PRINT_SIZE — the inked region: a color or a full-bleed image. Split into
//                   a left + right half.
//   3. DESIGN_AREA — the two safe square pages, side by side.

export const DPI = 300;

// The three boxes, in pixels at 300 DPI.
export const PAGE_AREA = { width: 10629.9, height: 7559.1 };
export const PRINT_SIZE = { width: 10339.2, height: 5428.2 };
export const DESIGN_AREA = { width: 4962.5, height: 4962.5 };

// Page Area aspect ratio — the page canvas is sized to this.
export const PAGE_AREA_RATIO = PAGE_AREA.width / PAGE_AREA.height; // ~1.406
export const PAGE_AREA_RATIO_CSS = `${PAGE_AREA.width} / ${PAGE_AREA.height}`;

// Convert a pixel measurement at our print DPI into millimeters.
export const px2mm = (px) => (px / DPI) * 25.4;

// A rectangle expressed as percentages of the Page Area (the canvas), ready to
// drop straight into CSS left/top/width/height.
const rect = (leftPx, topPx, wPx, hPx) => ({
  leftPct: (leftPx / PAGE_AREA.width) * 100,
  topPct: (topPx / PAGE_AREA.height) * 100,
  widthPct: (wPx / PAGE_AREA.width) * 100,
  heightPct: (hPx / PAGE_AREA.height) * 100,
});

// --- Print Size (centered in the Page Area), split into left + right halves ---
const printLeftPx = (PAGE_AREA.width - PRINT_SIZE.width) / 2;
const printTopPx = (PAGE_AREA.height - PRINT_SIZE.height) / 2;
const halfPrintW = PRINT_SIZE.width / 2;

export const PRINT_SIZE_RECT = rect(printLeftPx, printTopPx, PRINT_SIZE.width, PRINT_SIZE.height);
export const PRINT_LEFT_RECT = rect(printLeftPx, printTopPx, halfPrintW, PRINT_SIZE.height);
export const PRINT_RIGHT_RECT = rect(printLeftPx + halfPrintW, printTopPx, halfPrintW, PRINT_SIZE.height);

// --- Design Area: two squares side by side, centered in the Page Area, with a
// fixed gutter (the spine/fold gap) between them. ---
export const DESIGN_GUTTER = 91.5; // px between the two design areas
const designTopPx = (PAGE_AREA.height - DESIGN_AREA.height) / 2;
const designPairWidth = DESIGN_AREA.width * 2 + DESIGN_GUTTER;
const designPairLeftPx = (PAGE_AREA.width - designPairWidth) / 2;

export const DESIGN_LEFT_RECT = rect(designPairLeftPx, designTopPx, DESIGN_AREA.width, DESIGN_AREA.height);
export const DESIGN_RIGHT_RECT = rect(
  designPairLeftPx + DESIGN_AREA.width + DESIGN_GUTTER,
  designTopPx,
  DESIGN_AREA.width,
  DESIGN_AREA.height
);

// --- A single Print-half, used as the editor canvas so the bleed is visible ---
// The editor shows ONE print-half (one side's full inked area) with the Design
// square inset inside it. The margin between the square and the half edges IS
// the bleed. These describe the Design square as a % of the print-half, so the
// editor can position its inner (content) canvas exactly where it will print.
export const PRINT_HALF = { width: halfPrintW, height: PRINT_SIZE.height };
export const PRINT_HALF_RATIO_CSS = `${halfPrintW} / ${PRINT_SIZE.height}`;

const designRightLeftPx = designPairLeftPx + DESIGN_AREA.width + DESIGN_GUTTER;
const rightHalfLeftPx = printLeftPx + halfPrintW;

const rectInHalf = (designLeftPx, halfLeftPx) => ({
  leftPct: ((designLeftPx - halfLeftPx) / halfPrintW) * 100,
  topPct: ((designTopPx - printTopPx) / PRINT_SIZE.height) * 100,
  widthPct: (DESIGN_AREA.width / halfPrintW) * 100,
  heightPct: (DESIGN_AREA.height / PRINT_SIZE.height) * 100,
});

// Design square as a % of its print-half (left vs right differ: the gutter/spine
// side has less bleed than the outer side).
export const DESIGN_IN_HALF_LEFT = rectInHalf(designPairLeftPx, printLeftPx);
export const DESIGN_IN_HALF_RIGHT = rectInHalf(designRightLeftPx, rightHalfLeftPx);
