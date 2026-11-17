// Generates src/assets/world-dots.svg and src/assets/world-pins.json once,
// so the app ships a static image instead of a map library.
// Run: npm run gen:map
import { writeFileSync } from "node:fs";
import DottedMap from "dotted-map";

const map = new DottedMap({ height: 56, grid: "diagonal" });
const svg = map.getSVG({ radius: 0.24, color: "#FFFFFF", shape: "circle", backgroundColor: "transparent" });
writeFileSync(new URL("../src/assets/world-dots.svg", import.meta.url), svg);

// Approximate centroids of the two fixture legal cells (jurisdictions, not offices).
const pins = {
  uk: map.getPin({ lat: 54.0, lng: -2.0 }),
  eu: map.getPin({ lat: 50.1, lng: 9.0 }),
};
const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1];
writeFileSync(new URL("../src/assets/world-pins.json", import.meta.url), JSON.stringify({ viewBox, pins }, null, 2) + "\n");
console.log("world map written", viewBox, pins);
