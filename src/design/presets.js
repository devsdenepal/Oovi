/**
 * Design-type presets | the fixed canvas sizes the preview area is
 * restricted to (social / publishing formats).
 *
 * Pure data: no imports, no logic. The default is the Facebook feed post.
 * Dimensions follow the platforms' recommended upload sizes.
 */

export const DESIGN_PRESETS = [
  { id: "facebook-post", label: "Facebook Post", width: 1200, height: 630, hint: "Landscape 1.91:1" },
  { id: "facebook-square", label: "Facebook Square", width: 1080, height: 1080, hint: "Square 1:1" },
  { id: "instagram-portrait", label: "Instagram Portrait", width: 1080, height: 1350, hint: "Portrait 4:5" },
  { id: "story", label: "Story / Reel", width: 1080, height: 1920, hint: "Vertical 9:16" },
  { id: "x-post", label: "X Post", width: 1200, height: 675, hint: "Wide 16:9" },
  { id: "youtube-thumb", label: "YouTube Thumbnail", width: 1280, height: 720, hint: "Wide 16:9" },
];

export const DEFAULT_PRESET_ID = "facebook-post";

/**
 * @param {string} id
 * @returns {{id:string,label:string,width:number,height:number,hint:string}}
 */
export function getPreset(id) {
  return DESIGN_PRESETS.find((p) => p.id === id) || DESIGN_PRESETS[0];
}
