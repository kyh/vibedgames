/** Lowercase file extensions we recognize as media for both auto-upload
 *  detection (media-args) and result-payload parsing (media-download). */
export const MEDIA_EXT = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "avif",
  "mp4", "mov", "webm", "mp3", "wav", "ogg", "flac", "m4a",
]);
