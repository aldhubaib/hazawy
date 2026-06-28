// Pre-installed SVG symbol library for the page editor.
// Each symbol is authored on a "0 0 24 24" viewBox and uses `currentColor`
// (fill or stroke) so it can be tinted from the UI.

const S = (body, attrs = 'fill="currentColor"') =>
  `<svg viewBox="0 0 24 24" ${attrs}>${body}</svg>`;
// Outline helper: stroked, no fill.
const O = (body, w = 2) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const SYMBOL_LIBRARY = [
  // ---------- Shapes ----------
  { id: "circle", name: "Circle", category: "Shapes", svg: S(`<circle cx="12" cy="12" r="9"/>`) },
  { id: "circle-o", name: "Circle outline", category: "Shapes", svg: O(`<circle cx="12" cy="12" r="9"/>`) },
  { id: "square", name: "Square", category: "Shapes", svg: S(`<rect x="4" y="4" width="16" height="16" rx="2"/>`) },
  { id: "square-o", name: "Square outline", category: "Shapes", svg: O(`<rect x="4" y="4" width="16" height="16" rx="2"/>`) },
  { id: "triangle", name: "Triangle", category: "Shapes", svg: S(`<path d="M12 3l9.5 17H2.5z"/>`) },
  { id: "diamond", name: "Diamond", category: "Shapes", svg: S(`<path d="M12 2l10 10-10 10L2 12z"/>`) },
  { id: "pentagon", name: "Pentagon", category: "Shapes", svg: S(`<path d="M12 2l9.5 6.9-3.63 11.2H6.13L2.5 8.9z"/>`) },
  { id: "hexagon", name: "Hexagon", category: "Shapes", svg: S(`<path d="M7 3h10l5 9-5 9H7l-5-9z"/>`) },
  { id: "oval", name: "Oval", category: "Shapes", svg: S(`<ellipse cx="12" cy="12" rx="9" ry="6"/>`) },
  { id: "ring", name: "Ring", category: "Shapes", svg: S(`<path fill-rule="evenodd" d="M12 3a9 9 0 100 18 9 9 0 000-18zm0 5a4 4 0 110 8 4 4 0 010-8z"/>`) },
  { id: "plus", name: "Plus", category: "Shapes", svg: S(`<path d="M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7z"/>`) },
  { id: "cross", name: "Cross", category: "Shapes", svg: O(`<path d="M6 6l12 12M18 6L6 18"/>`, 2.5) },
  { id: "blob", name: "Blob", category: "Shapes", svg: S(`<path d="M12 2c4 0 8 2 8 7 0 4-2 5-2 8s-3 5-6 5-7-2-7-6c0-3-2-4-2-7 0-5 5-7 9-7z"/>`) },

  // ---------- Stars & sparkle ----------
  { id: "star", name: "Star", category: "Stars", svg: S(`<path d="M12 2l2.9 6.26L21.5 9l-5 4.6L18 21l-6-3.5L6 21l1.5-7.4-5-4.6 6.6-.74z"/>`) },
  { id: "star-o", name: "Star outline", category: "Stars", svg: O(`<path d="M12 3l2.7 5.8 6.3.8-4.6 4.3 1.1 7.1L12 17.7 6.5 21l1.1-7.1L3 9.6l6.3-.8z"/>`) },
  { id: "sparkle", name: "Sparkle", category: "Stars", svg: S(`<path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z"/>`) },
  { id: "fourstar", name: "4-point star", category: "Stars", svg: S(`<path d="M12 2c.6 5 2 6.4 7 7-5 .6-6.4 2-7 7-.6-5-2-6.4-7-7 5-.6 6.4-2 7-7z"/>`) },
  { id: "burst", name: "Burst", category: "Stars", svg: S(`<path d="M12 2l1.6 4.2L17 3.5l-.9 4.4 4.4-.9-2.7 3.4L22 12l-4.2 1.6L20.5 17l-4.4-.9.9 4.4-3.4-2.7L12 22l-1.6-4.2L7 20.5l.9-4.4-4.4.9 2.7-3.4L2 12l4.2-1.6L3.5 7l4.4.9L7 3.5l3.4 2.7z"/>`) },
  { id: "twinkle", name: "Twinkle", category: "Stars", svg: S(`<path d="M12 3c.4 4 1.2 4.8 5 5.2-3.8.4-4.6 1.2-5 5.2-.4-4-1.2-4.8-5-5.2 3.8-.4 4.6-1.2 5-5.2z"/><circle cx="18" cy="16" r="1.4"/><circle cx="6" cy="17" r="1"/>`) },
  { id: "shooting-star", name: "Shooting star", category: "Stars", svg: S(`<path d="M17 2l1.5 3.3L22 6.5l-3.3 1.4L17 11l-1.5-3.1L12 6.5l3.5-1.2z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M3 20l8-6"/>`) },

  // ---------- Weather ----------
  { id: "sun", name: "Sun", category: "Weather", svg: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path fill="none" d="M12 1.5v2.5M12 20v2.5M1.5 12h2.5M20 12h2.5M4.2 4.2l1.8 1.8M18 18l1.8 1.8M19.8 4.2L18 6M6 18l-1.8 1.8"/></svg>` },
  { id: "moon", name: "Moon", category: "Weather", svg: S(`<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>`) },
  { id: "cloud", name: "Cloud", category: "Weather", svg: S(`<path d="M7 18a5 5 0 0 1-.5-9.97A6 6 0 0 1 18 8a4 4 0 0 1 .5 7.97V18H7z"/>`) },
  { id: "rainbow", name: "Rainbow", category: "Weather", svg: O(`<path d="M3 19a9 9 0 0 1 18 0"/><path d="M6 19a6 6 0 0 1 12 0"/><path d="M9 19a3 3 0 0 1 6 0"/>`) },
  { id: "snowflake", name: "Snowflake", category: "Weather", svg: O(`<path d="M12 2v20M2 12h20M5 5l14 14M19 5L5 19"/>`) },
  { id: "raindrop", name: "Raindrop", category: "Weather", svg: S(`<path d="M12 2c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z"/>`) },
  { id: "lightning", name: "Lightning", category: "Weather", svg: S(`<path d="M13 2L4 14h6l-1 8 9-12h-6z"/>`) },
  { id: "wind", name: "Wind", category: "Weather", svg: O(`<path d="M3 8h11a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h9a2.5 2.5 0 1 1-2.5 2.5"/>`) },
  { id: "umbrella", name: "Umbrella", category: "Weather", svg: S(`<path d="M12 2a10 10 0 0 1 10 10H2A10 10 0 0 1 12 2z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 12v7a2.5 2.5 0 0 0 5 0"/>`) },

  // ---------- Nature ----------
  { id: "leaf", name: "Leaf", category: "Nature", svg: S(`<path d="M5 19C5 9 11 4 20 4c0 9-5 15-15 15z"/>`) },
  { id: "flower", name: "Flower", category: "Nature", svg: S(`<circle cx="12" cy="5" r="3"/><circle cx="12" cy="19" r="3"/><circle cx="5" cy="12" r="3"/><circle cx="19" cy="12" r="3"/><circle cx="12" cy="12" r="3"/>`) },
  { id: "flower2", name: "Daisy", category: "Nature", svg: S(`<g><ellipse cx="12" cy="5.5" rx="2" ry="3.5"/><ellipse cx="12" cy="18.5" rx="2" ry="3.5"/><ellipse cx="5.5" cy="12" rx="3.5" ry="2"/><ellipse cx="18.5" cy="12" rx="3.5" ry="2"/><ellipse cx="7.4" cy="7.4" rx="2" ry="3.5" transform="rotate(-45 7.4 7.4)"/><ellipse cx="16.6" cy="16.6" rx="2" ry="3.5" transform="rotate(-45 16.6 16.6)"/><ellipse cx="16.6" cy="7.4" rx="3.5" ry="2" transform="rotate(-45 16.6 7.4)"/><ellipse cx="7.4" cy="16.6" rx="3.5" ry="2" transform="rotate(-45 7.4 16.6)"/></g><circle cx="12" cy="12" r="3" fill="#fff" fill-opacity="0.001"/>`) },
  { id: "tree", name: "Tree", category: "Nature", svg: S(`<path d="M12 2l6 8h-3l4 6H5l4-6H6z"/><rect x="11" y="15" width="2" height="6"/>`) },
  { id: "pine", name: "Pine tree", category: "Nature", svg: S(`<path d="M12 2l5 7h-3l4 6h-3l3 4H6l3-4H6l4-6H7z"/><rect x="11" y="19" width="2" height="3"/>`) },
  { id: "sprout", name: "Sprout", category: "Nature", svg: O(`<path d="M12 21v-7"/><path d="M12 14c0-3-2-5-6-5 0 4 3 6 6 5z" fill="currentColor" stroke="none"/><path d="M12 12c0-3 2-5 6-5 0 4-3 6-6 5z" fill="currentColor" stroke="none"/>`) },
  { id: "clover", name: "Clover", category: "Nature", svg: S(`<path d="M12 12c-1-3-4-4-5.5-2.5S6 14 9 13c-3 1-3.5 4-2 5.5S11 17 12 14c-1 3 0 6 1.5 4.5S15 14 13 13c3 1 6 0 4.5-1.5S15 9 12 12z"/><path fill="none" stroke="currentColor" stroke-width="1.5" d="M12 14v7"/>`) },
  { id: "mushroom", name: "Mushroom", category: "Nature", svg: S(`<path d="M3 11a9 7 0 0 1 18 0z"/><path d="M9 11h6v6a3 3 0 0 1-6 0z"/>`) },
  { id: "mountain", name: "Mountain", category: "Nature", svg: S(`<path d="M3 20l6-11 4 6 2-3 6 8z"/>`) },
  { id: "wave", name: "Wave", category: "Nature", svg: O(`<path d="M2 9c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/><path d="M2 15c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/>`) },
  { id: "fire", name: "Fire", category: "Nature", svg: S(`<path d="M12 2c1 3-1 4-2 6-1.5 3 .5 4 .5 4S9 9 12 7c0 0 4 3 4 8a4 4 0 1 1-8 0c0-2 1-3 1-3-2 1-3 3-3 5a6 6 0 1 0 12 0c0-6-6-9-6-15z"/>`) },

  // ---------- Celebration ----------
  { id: "crown", name: "Crown", category: "Celebration", svg: S(`<path d="M2 8l4.5 3.5L12 4l5.5 7.5L22 8l-2 11H4L2 8z"/>`) },
  { id: "balloon", name: "Balloon", category: "Celebration", svg: S(`<path d="M12 2a7 7 0 0 1 7 7c0 4.5-4 8-7 8s-7-3.5-7-8a7 7 0 0 1 7-7z"/><path fill="none" stroke="currentColor" stroke-width="1.5" d="M12 17v4"/>`) },
  { id: "gift", name: "Gift", category: "Celebration", svg: S(`<path d="M3 8h18v3H3z"/><path d="M5 11h14v10H5z"/><rect x="11" y="3" width="2" height="18"/><path fill="none" stroke="currentColor" stroke-width="2" d="M12 8C12 5 9 3 8 4.5S9 8 12 8zM12 8c0-3 3-5 4-3.5S15 8 12 8z"/>`) },
  { id: "cake", name: "Cake", category: "Celebration", svg: S(`<path d="M4 14a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6H4z"/><rect x="6" y="8" width="2" height="4"/><rect x="11" y="8" width="2" height="4"/><rect x="16" y="8" width="2" height="4"/><circle cx="7" cy="6" r="1"/><circle cx="12" cy="6" r="1"/><circle cx="17" cy="6" r="1"/>`) },
  { id: "partyhat", name: "Party hat", category: "Celebration", svg: S(`<path d="M12 2l6 16H6z"/><circle cx="12" cy="3" r="1.4"/><circle cx="10" cy="9" r="1"/><circle cx="14" cy="13" r="1"/><path d="M4 20h16v2H4z"/>`) },
  { id: "confetti", name: "Confetti", category: "Celebration", svg: S(`<rect x="3" y="3" width="3" height="3" transform="rotate(20 4.5 4.5)"/><rect x="18" y="5" width="3" height="3" transform="rotate(-15 19.5 6.5)"/><circle cx="6" cy="14" r="1.4"/><circle cx="19" cy="16" r="1.4"/><rect x="11" y="2" width="2.6" height="2.6" transform="rotate(30 12 3)"/><path d="M4 21l8-9 8 9z" fill="none" stroke="currentColor" stroke-width="0"/><circle cx="12" cy="20" r="1.4"/>`) },
  { id: "ribbon", name: "Ribbon", category: "Celebration", svg: S(`<circle cx="12" cy="8" r="5"/><path d="M9 12l-2 9 5-3 5 3-2-9z"/>`) },
  { id: "bell", name: "Bell", category: "Celebration", svg: S(`<path d="M12 2a6 6 0 0 0-6 6c0 5-2 7-2 7h16s-2-2-2-7a6 6 0 0 0-6-6z"/><path d="M10 19a2 2 0 0 0 4 0z"/>`) },
  { id: "candy", name: "Candy", category: "Celebration", svg: S(`<circle cx="12" cy="12" r="5"/><path d="M3 8l4 4-4 4 1-4zM21 8l-4 4 4 4-1-4z"/>`) },
  { id: "lollipop", name: "Lollipop", category: "Celebration", svg: S(`<circle cx="10" cy="8" r="6"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M11 13l4 8"/>`) },

  // ---------- Food ----------
  { id: "icecream", name: "Ice cream", category: "Food", svg: S(`<path d="M7 9a5 5 0 0 1 10 0z"/><path d="M7 9h10l-5 12z"/>`) },
  { id: "donut", name: "Donut", category: "Food", svg: S(`<path fill-rule="evenodd" d="M12 3a9 9 0 100 18 9 9 0 000-18zm0 6a3 3 0 110 6 3 3 0 010-6z"/>`) },
  { id: "apple", name: "Apple", category: "Food", svg: S(`<path d="M12 7c-2-2-7-2-7 4 0 5 3 10 5 10 1 0 1.5-.6 2-.6s1 .6 2 .6c2 0 5-5 5-10 0-6-5-6-7-4z"/><path d="M12 7c0-2 1-4 3-4 0 2-1 4-3 4z"/>`) },
  { id: "cupcake", name: "Cupcake", category: "Food", svg: S(`<path d="M5 11a7 7 0 0 1 14 0z"/><path d="M6 12h12l-1.5 9h-9z"/>`) },
  { id: "cookie", name: "Cookie", category: "Food", svg: S(`<path d="M12 3a9 9 0 1 0 9 9 3 3 0 0 1-3-3 3 3 0 0 1-3-3 3 3 0 0 1-3-3z"/><circle cx="9" cy="13" r="1.2" fill="#000" fill-opacity="0.001"/>`) },
  { id: "cherry", name: "Cherry", category: "Food", svg: S(`<circle cx="7" cy="17" r="4"/><circle cx="17" cy="17" r="4"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M7 13c0-6 5-8 12-9M17 13c0-4 1-6 2-9"/>`) },

  // ---------- Animals ----------
  { id: "paw", name: "Paw", category: "Animals", svg: S(`<circle cx="6" cy="10" r="2"/><circle cx="10" cy="6" r="2"/><circle cx="14" cy="6" r="2"/><circle cx="18" cy="10" r="2"/><path d="M12 12c3 0 5 2 5 4.5S15 20 12 20s-5-1-5-3.5S9 12 12 12z"/>`) },
  { id: "cat", name: "Cat", category: "Animals", svg: S(`<path d="M4 4l3 4h10l3-4 1 10a8 6 0 0 1-18 0z"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/>`) },
  { id: "fish", name: "Fish", category: "Animals", svg: S(`<path d="M2 12c4-6 12-6 16 0-4 6-12 6-16 0z"/><path d="M18 12l4-4v8z"/><circle cx="7" cy="11" r="1"/>`) },
  { id: "bird", name: "Bird", category: "Animals", svg: S(`<path d="M3 7a4 4 0 0 1 8 0c2 0 8 1 8 7l3 2-3 1c-1 3-4 4-7 4-5 0-9-4-9-9 0-3 0-5 0-6z"/><circle cx="6" cy="7" r="1" fill="#000" fill-opacity="0.001"/>`) },
  { id: "butterfly", name: "Butterfly", category: "Animals", svg: S(`<path d="M12 6c1.2-2.5 3.2-4 5.5-4C20 2 21.5 3.7 21.5 6c0 3.3-3.5 5.5-9.5 5.5 6 0 9.5 2.2 9.5 5.5 0 2.3-1.5 4-3.5 4-2.3 0-4.3-1.5-5.5-4-1.2 2.5-3.2 4-5.5 4C4.5 21 3 19.3 3 17c0-3.3 3.5-5.5 9.5-5.5C6.5 11.5 3 9.3 3 6c0-2.3 1.5-4 3.5-4C8.8 2 10.8 3.5 12 6z"/><path fill="none" stroke="currentColor" stroke-width="1.4" d="M12 6v12"/>`) },
  { id: "bee", name: "Bee", category: "Animals", svg: S(`<ellipse cx="12" cy="14" rx="5" ry="6"/><path fill="#000" fill-opacity="0.001" d="M7 12h10M7 16h10"/><circle cx="12" cy="6" r="2.5"/><path fill="none" stroke="currentColor" stroke-width="1.5" d="M10 5L7 2M14 5l3-3"/>`) },
  { id: "snail", name: "Snail", category: "Animals", svg: S(`<path d="M3 18h6a6 6 0 1 0-6-6 5 5 0 0 0 10 0 3 3 0 0 0-6 0"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M3 18h2"/>`) },
  { id: "ladybug", name: "Ladybug", category: "Animals", svg: S(`<path d="M3 13a9 6 0 0 1 18 0 9 6 0 0 1-18 0z"/><path fill="#000" fill-opacity="0.001" d="M12 7v12"/><circle cx="8" cy="12" r="1.2" fill="#000" fill-opacity="0.001"/>`) },
  { id: "rabbit", name: "Rabbit", category: "Animals", svg: S(`<ellipse cx="12" cy="16" rx="6" ry="5"/><ellipse cx="9" cy="6" rx="1.6" ry="4"/><ellipse cx="15" cy="6" rx="1.6" ry="4"/>`) },

  // ---------- Travel & toys ----------
  { id: "rocket", name: "Rocket", category: "Travel", svg: S(`<path d="M12 2c4 2 6 6 6 11l-2 3H8l-2-3c0-5 2-9 6-11z"/><path d="M8 16l-3 4 4-1zM16 16l3 4-4-1z"/><circle cx="12" cy="9" r="1.6" fill="#000" fill-opacity="0.001"/>`) },
  { id: "plane", name: "Plane", category: "Travel", svg: S(`<path d="M2 14l9-2V5a1.5 1.5 0 0 1 3 0v6l8 2v2l-8-1v4l2 2v1l-4-1-4 1v-1l2-2v-4l-8 1z"/>`) },
  { id: "boat", name: "Boat", category: "Travel", svg: S(`<path d="M4 14h16l-2 6H6z"/><path d="M11 3l6 3-6 3z"/><rect x="11" y="3" width="1.5" height="11"/>`) },
  { id: "car", name: "Car", category: "Travel", svg: S(`<path d="M4 13l2-5a3 3 0 0 1 3-2h6a3 3 0 0 1 3 2l2 5v4H4z"/><circle cx="8" cy="17" r="2"/><circle cx="16" cy="17" r="2"/>`) },
  { id: "kite", name: "Kite", category: "Travel", svg: S(`<path d="M12 2l7 7-7 7-7-7z"/><path fill="none" stroke="currentColor" stroke-width="1.5" d="M12 16v5"/><path fill="none" stroke="currentColor" stroke-width="1.2" d="M12 9l0 7M5 9h14"/>`) },
  { id: "anchor", name: "Anchor", category: "Travel", svg: O(`<circle cx="12" cy="5" r="2"/><path d="M12 7v14M5 13a7 7 0 0 0 14 0M8 11H4M20 11h-4"/>`) },
  { id: "ball", name: "Ball", category: "Travel", svg: O(`<circle cx="12" cy="12" r="9"/><path d="M12 3v18M3 12h18M5 6c4 2 10 2 14 0M5 18c4-2 10-2 14 0"/>`) },

  // ---------- UI & symbols ----------
  { id: "arrow-up", name: "Arrow up", category: "Arrows", svg: O(`<path d="M12 20V4M5 11l7-7 7 7"/>`, 2.5) },
  { id: "arrow-down", name: "Arrow down", category: "Arrows", svg: O(`<path d="M12 4v16M5 13l7 7 7-7"/>`, 2.5) },
  { id: "arrow-left", name: "Arrow left", category: "Arrows", svg: O(`<path d="M20 12H4M11 5l-7 7 7 7"/>`, 2.5) },
  { id: "arrow-right", name: "Arrow right", category: "Arrows", svg: O(`<path d="M4 12h16M13 5l7 7-7 7"/>`, 2.5) },
  { id: "check", name: "Check", category: "Arrows", svg: O(`<path d="M4 12l5 6L20 5"/>`, 2.5) },
  { id: "music", name: "Music note", category: "Symbols", svg: S(`<circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/><path d="M9 18V6l11-2v12h-2V6.5L11 8v10z"/>`) },
  { id: "speech", name: "Speech bubble", category: "Symbols", svg: S(`<path d="M4 4h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-0-0V6a2 2 0 0 1 2-2z"/>`) },
  { id: "smiley", name: "Smiley", category: "Symbols", svg: O(`<circle cx="12" cy="12" r="9"/><path d="M8 14a5 5 0 0 0 8 0"/><circle cx="9" cy="10" r="0.6" fill="currentColor"/><circle cx="15" cy="10" r="0.6" fill="currentColor"/>`) },
  { id: "key", name: "Key", category: "Symbols", svg: O(`<circle cx="8" cy="8" r="4"/><path d="M11 11l9 9M16 16l2-2M19 19l2-2"/>`) },
  { id: "bookmark", name: "Bookmark", category: "Symbols", svg: S(`<path d="M6 2h12v20l-6-4-6 4z"/>`) },
  { id: "flag", name: "Flag", category: "Symbols", svg: S(`<path d="M5 3v18"/><path d="M5 4h13l-3 4 3 4H5z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M5 3v18"/>`) },
  { id: "pin", name: "Location pin", category: "Symbols", svg: S(`<path d="M12 2a7 7 0 0 1 7 7c0 5-7 13-7 13S5 14 5 9a7 7 0 0 1 7-7z"/><circle cx="12" cy="9" r="2.5" fill="#000" fill-opacity="0.001"/>`) },
  { id: "camera", name: "Camera", category: "Symbols", svg: S(`<path d="M3 7h4l2-2h6l2 2h4v12H3z"/><circle cx="12" cy="13" r="3.5" fill="#000" fill-opacity="0.001"/>`) },
  { id: "book", name: "Book", category: "Symbols", svg: S(`<path d="M4 4h7a2 2 0 0 1 1 1.7V21a3 3 0 0 0-2-1H4z"/><path d="M20 4h-7a2 2 0 0 0-1 1.7V21a3 3 0 0 1 2-1h6z"/>`) },
  { id: "globe", name: "Globe", category: "Symbols", svg: O(`<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>`) },
];

// Stable list of categories in display order (deduped by first appearance).
export const SYMBOL_CATEGORIES = SYMBOL_LIBRARY.reduce((acc, s) => {
  if (!acc.includes(s.category)) acc.push(s.category);
  return acc;
}, []);

// Normalize raw SVG markup from an upload: drop XML prolog/comments and
// keep only the <svg> root, stripping scripts and inline event handlers.
export function sanitizeSvg(raw) {
  if (!raw) return "";
  let s = String(raw).trim();
  s = s.replace(/<\?xml[\s\S]*?\?>/gi, "");
  s = s.replace(/<!DOCTYPE[\s\S]*?>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  const start = s.toLowerCase().indexOf("<svg");
  const end = s.toLowerCase().lastIndexOf("</svg>");
  if (start === -1 || end === -1) return "";
  s = s.slice(start, end + 6);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/\son\w+="[^"]*"/gi, "");
  return s.trim();
}

// Apply tint: rewrite explicit fill/stroke colors to `currentColor` so the
// element's CSS `color` controls the symbol. Leaves `none` values intact.
export function tintSvg(svg, tint) {
  if (!svg) return "";
  if (!tint) return svg;
  return svg
    .replace(/fill="(?!none|currentColor)[^"]*"/gi, 'fill="currentColor"')
    .replace(/stroke="(?!none|currentColor)[^"]*"/gi, 'stroke="currentColor"')
    .replace(/fill:\s*(?!none|currentColor)[^;"']+/gi, "fill:currentColor")
    .replace(/stroke:\s*(?!none|currentColor)[^;"']+/gi, "stroke:currentColor");
}
