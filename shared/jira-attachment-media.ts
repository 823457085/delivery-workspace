const mediaTypes: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
};
const supported = new Set(Object.values(mediaTypes));
/** Only passive media is served inline; HTML and SVG remain downloads. */
export function jiraAttachmentMediaType(file: { mimeType?: string; filename: string }): string | undefined {
  const mime = (file.mimeType || '').split(';')[0]!.trim().toLowerCase();
  if (supported.has(mime)) return mime;
  if (mime && mime !== 'application/octet-stream') return;
  return mediaTypes[file.filename.split('.').at(-1)?.toLowerCase() || ''];
}
