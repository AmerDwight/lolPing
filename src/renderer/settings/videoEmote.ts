import { ANIM_MAX_BYTES, SHARED_ANIM_SIDE, SOUND_MAX_BYTES, VIDEO_MAX_BYTES, type EmoteFile, type ImportError } from '../../shared/emotes';
import { sniffVideo } from '../../shared/videoSniff';
import { encodeWav } from '../../shared/wav';
import { muxWebpAnimation, type WebpFrame } from '../../shared/webpAnim';
import { encodeSharedAnim, type AnimSource } from '../shared/animShare';
import { encodeShared } from '../shared/soundShare';
import { clipArtSize, clipAttempts, clipFrames, initialRange, keptScale, type ClipRange } from './clipRange';
import { encodeStill, fitSize, nameFromFile } from './emoteImport';

/** A picked video, ready for the trim dialog: an object URL for its preview, its length and size. Revoke `url` when done. */
export interface LoadedVideo {
  url: string;
  duration: number;
  width: number;
  height: number;
}

/** What a trimmed clip becomes: the import, and the sound to give it once it is saved, with its copy for rooms. */
export interface PreparedClip {
  file: EmoteFile;
  sound: { bytes: Uint8Array; share: Uint8Array | null } | null;
}

/** A seek that never lands (a broken file) gives up after this long. */
const SEEK_TIMEOUT_MS = 5000;
/** The still is drawn from a frame scaled to at most this; encodeStill scales it down again to 160 px. */
const STILL_SOURCE_SIDE = 1024;

/** A video by its first bytes: MP4, MOV, M4V, WebM or Matroska. Whether it plays is up to loadVideo. */
export async function isVideoFile(file: File): Promise<boolean> {
  return sniffVideo(new Uint8Array(await file.slice(0, 16).arrayBuffer())) !== null;
}

function videoElement(url: string): HTMLVideoElement {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  video.src = url;
  return video;
}

/** Waits for `event` on `el`, or rejects on its 'error' or after `ms`. */
function once(el: HTMLMediaElement, event: string, ms = SEEK_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (ok: boolean) => () => {
      clearTimeout(timer);
      el.removeEventListener(event, onEvent);
      el.removeEventListener('error', onError);
      if (ok) resolve();
      else reject(new Error(`video ${event} failed`));
    };
    const onEvent = done(true);
    const onError = done(false);
    const timer = setTimeout(onError, ms);
    el.addEventListener(event, onEvent);
    el.addEventListener('error', onError);
  });
}

/**
 * Opens a picked video for trimming. Refused when it is over VIDEO_MAX_BYTES ('videoSize'), isn't a video this
 * Chromium plays ('videoType'), or is shorter than a clip may be ('videoShort').
 */
export async function loadVideo(file: File): Promise<{ ok: true; video: LoadedVideo } | { ok: false; error: ImportError }> {
  if (file.size > VIDEO_MAX_BYTES) return { ok: false, error: 'videoSize' };
  if (!(await isVideoFile(file))) return { ok: false, error: 'videoType' };
  const url = URL.createObjectURL(file);
  const video = videoElement(url);
  try {
    await once(video, 'loadedmetadata');
    if (video.videoWidth === 0 || video.videoHeight === 0) throw new Error('no picture'); // a sound in a video container
    if (!initialRange(video.duration)) {
      URL.revokeObjectURL(url);
      return { ok: false, error: 'videoShort' };
    }
    return { ok: true, video: { url, duration: video.duration, width: video.videoWidth, height: video.videoHeight } };
  } catch {
    URL.revokeObjectURL(url);
    return { ok: false, error: 'videoType' };
  } finally {
    video.removeAttribute('src');
    video.load(); // lets go of the decoder; the preview opens its own
  }
}

/** The video's sound track, decoded, or null when it has none this Chromium can decode. */
export async function decodeVideoSound(file: File): Promise<AudioBuffer | null> {
  try {
    const bytes = await file.arrayBuffer();
    return await new OfflineAudioContext(1, 1, 44_100).decodeAudioData(bytes);
  } catch {
    return null;
  }
}

/** Seeks `video` to `at` seconds and waits until that frame can be drawn. */
async function seek(video: HTMLVideoElement, at: number): Promise<void> {
  if (video.currentTime === at && !video.seeking && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
  const seeked = once(video, 'seeked');
  video.currentTime = at;
  await seeked;
}

/** At most two channels of `sound` between the range's start and end, as a new buffer. */
function soundSlice(sound: AudioBuffer, r: ClipRange): AudioBuffer {
  const from = Math.min(sound.length, Math.max(0, Math.floor(r.start * sound.sampleRate)));
  const to = Math.min(sound.length, Math.max(from + 1, Math.ceil(r.end * sound.sampleRate)));
  const channels = Math.min(2, sound.numberOfChannels);
  const out = new AudioBuffer({ length: to - from, numberOfChannels: channels, sampleRate: sound.sampleRate });
  for (let c = 0; c < channels; c++) out.copyToChannel(sound.getChannelData(c).subarray(from, to), c);
  return out;
}

/** The clip's sound as a WAV of at most SOUND_MAX_BYTES (mono when stereo wouldn't fit), and its copy for rooms. */
async function clipSound(sound: AudioBuffer, r: ClipRange): Promise<PreparedClip['sound']> {
  const slice = soundSlice(sound, r);
  const channels = Array.from({ length: slice.numberOfChannels }, (_, c) => slice.getChannelData(c));
  let bytes = encodeWav(channels, slice.sampleRate);
  if (bytes.length > SOUND_MAX_BYTES && channels.length > 1) {
    const mono = new Float32Array(slice.length);
    for (let i = 0; i < mono.length; i++) mono[i] = (channels[0][i] + channels[1][i]) / 2;
    bytes = encodeWav([mono], slice.sampleRate);
  }
  if (bytes.length > SOUND_MAX_BYTES) return null;
  return { bytes, share: await encodeShared(slice) };
}

/** The still: the clip's first frame, drawn at up to STILL_SOURCE_SIDE and encoded the way an image's still is. */
async function clipStill(video: HTMLVideoElement, r: ClipRange): Promise<Uint8Array | null> {
  await seek(video, r.start);
  const size = fitSize(video.videoWidth, video.videoHeight, STILL_SOURCE_SIDE);
  const canvas = new OffscreenCanvas(size.width, size.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, size.width, size.height);
  const frame = new VideoFrame(canvas, { timestamp: 0 });
  try {
    return await encodeStill(frame);
  } finally {
    frame.close();
  }
}

const closeAll = (frames: readonly AnimSource[]): void => {
  for (const f of frames) f.image.close();
};

/**
 * The clip's frames as an animated WebP, at the first of clipAttempts that fits ANIM_MAX_BYTES, and the same frames
 * small, for the copy room members get. An attempt stops as soon as its frames add up to more than that. `progress` gets
 * 0 to 1 within the attempt being tried. The caller closes `small`.
 */
async function clipAnimation(
  video: HTMLVideoElement, r: ClipRange, progress: (done: number) => void,
): Promise<{ anim: Uint8Array; side: number; small: AnimSource[] } | null> {
  const longest = Math.max(video.videoWidth, video.videoHeight);
  const thumb = fitSize(video.videoWidth, video.videoHeight, SHARED_ANIM_SIDE);
  for (const attempt of clipAttempts(longest)) {
    const size = fitSize(video.videoWidth, video.videoHeight, attempt.side);
    const canvas = new OffscreenCanvas(size.width, size.height);
    const ctx = canvas.getContext('2d', { alpha: false }); // a video has no transparency, and the frames come out smaller
    if (!ctx) return null;
    ctx.imageSmoothingQuality = 'high';
    const times = clipFrames(r, attempt.fps);
    const frames: WebpFrame[] = [];
    const small: AnimSource[] = [];
    let bytes = 0;
    try {
      for (const [i, f] of times.entries()) {
        await seek(video, f.at);
        ctx.drawImage(video, 0, 0, size.width, size.height);
        const blob = await canvas.convertToBlob({ type: 'image/webp', quality: attempt.quality });
        if (blob.type !== 'image/webp') return null; // no WebP encoder: nothing would ever fit
        bytes += blob.size;
        if (bytes > ANIM_MAX_BYTES) break;
        frames.push({ file: new Uint8Array(await blob.arrayBuffer()), ms: f.ms });
        small.push({ image: await createImageBitmap(canvas, { resizeWidth: thumb.width, resizeHeight: thumb.height, resizeQuality: 'high' }), ms: f.ms });
        progress((i + 1) / times.length);
      }
      const anim = frames.length === times.length ? muxWebpAnimation(frames, size.width, size.height) : null;
      if (anim && anim.length <= ANIM_MAX_BYTES) return { anim, side: Math.max(size.width, size.height), small: small.splice(0) };
    } finally {
      closeAll(small); // what wasn't handed back
    }
  }
  return null;
}

/**
 * Makes an emote from the clip `r` of a loaded video, shown at `scale` percent of clipArtSize: its frames as the
 * animation and a small copy of them for rooms, its first frame as the still, and, when `sound` is given, that part of
 * the sound. 'detail' when the still can't be made small enough, 'animSize' when the
 * frames can't, 'videoType' when the video stops playing along the way.
 */
export async function prepareClip(
  name: string, video: LoadedVideo, r: ClipRange, sound: AudioBuffer | null, scale: number, progress: (done: number) => void,
): Promise<{ ok: true; clip: PreparedClip } | { ok: false; error: ImportError }> {
  const el = videoElement(video.url);
  try {
    await once(el, 'loadeddata');
    const still = await clipStill(el, r);
    if (!still) return { ok: false, error: 'detail' };
    const made = await clipAnimation(el, r, progress);
    if (!made) return { ok: false, error: 'animSize' };
    let shareAnim: Uint8Array | null;
    try {
      shareAnim = await encodeSharedAnim(made.small, true);
    } finally {
      closeAll(made.small);
    }
    const clip = Math.round((r.end - r.start) * 1000);
    const planned = clipArtSize(video.width, video.height);
    const kept = keptScale(scale, Math.max(planned.width, planned.height), made.side);
    const file: EmoteFile = { name: nameFromFile(name), still, anim: made.anim, clip, scale: kept, ...(shareAnim ? { shareAnim } : {}) };
    return { ok: true, clip: { file, sound: sound ? await clipSound(sound, r) : null } };
  } catch {
    return { ok: false, error: 'videoType' };
  } finally {
    el.removeAttribute('src');
    el.load();
  }
}
