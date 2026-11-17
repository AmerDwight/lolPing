export type VideoType = 'mp4' | 'webm';

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const startsWith = (b: Uint8Array, at: number, sig: readonly number[]): boolean =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

/** The box types an MP4 or QuickTime file can open with; `ftyp` in anything recent, the others in old QuickTime files. */
const MP4_FIRST_BOXES = ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].map(ascii);

/**
 * Names a video by its first bytes, never by its extension or a claimed type: 'mp4' for MP4, M4V and MOV (an ISO base
 * media box), 'webm' for WebM and Matroska (an EBML header). Whether this Chromium can decode it is another question.
 */
export function sniffVideo(bytes: Uint8Array): VideoType | null {
  if (startsWith(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3])) return 'webm';
  if (MP4_FIRST_BOXES.some((box) => startsWith(bytes, 4, box))) return 'mp4';
  return null;
}
