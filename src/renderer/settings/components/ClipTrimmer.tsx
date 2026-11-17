import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Spinner, Switch,
} from '@fluentui/react-components';
import { Pause24Regular, Play24Regular } from '@fluentui/react-icons';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { ImportError } from '../../../shared/emotes';
import { clipArtSize, dragClip, dragEnd, dragStart, formatClock, initialRange, type ClipRange } from '../clipRange';
import { useText } from '../text';
import { decodeVideoSound, loadVideo, prepareClip, type LoadedVideo, type PreparedClip } from '../videoEmote';
import { SizeSlider } from './EmoteSizer';

export type ClipResult = { ok: true; clip: PreparedClip } | { ok: false; error: ImportError } | null;

type Drag = { kind: 'start' | 'end' | 'clip'; from: number; range: ClipRange };

/** Arrow keys move an edge by this much, with Shift by a second. */
const STEP_S = 0.1;

/**
 * The trim dialog a picked video opens: a preview that loops the chosen part, a track with its two edges and the part
 * between them to drag, the emote's size, and whether to keep the sound. `onDone` gets the prepared clip, an error (the video can't be
 * used, or the clip can't be made small enough), or null when cancelled.
 */
export function ClipTrimmer({ file, onDone }: { file: File; onDone(result: ClipResult): void }) {
  const t = useText();
  const [video, setVideo] = useState<LoadedVideo | null>(null);
  const [range, setRange] = useState<ClipRange>({ start: 0, end: 0 });
  // undefined while it is being decoded, null for a video with no sound this Chromium can decode.
  const [sound, setSound] = useState<AudioBuffer | null | undefined>(undefined);
  const [keepSound, setKeepSound] = useState(true);
  const [scale, setScale] = useState(100);
  const [playing, setPlaying] = useState(true);
  const [head, setHead] = useState(0);
  const [working, setWorking] = useState<number | null>(null);
  const preview = useRef<HTMLVideoElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const rangeNow = useRef(range);
  rangeNow.current = range;
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    let live = true;
    let url: string | null = null;
    void loadVideo(file).then((r) => {
      if (!live) {
        if (r.ok) URL.revokeObjectURL(r.video.url);
        return;
      }
      if (!r.ok) {
        done.current({ ok: false, error: r.error });
        return;
      }
      url = r.video.url;
      setVideo(r.video);
      setRange(initialRange(r.video.duration) ?? { start: 0, end: r.video.duration });
    });
    void decodeVideoSound(file).then((s) => {
      if (live) setSound(s);
    });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file]);

  // The preview loops the clip: back to its start whenever it runs past its end, checked every frame.
  useEffect(() => {
    const el = preview.current;
    if (!el || !video) return;
    let frame = 0;
    const loop = () => {
      const r = rangeNow.current;
      if (!drag.current && (el.currentTime >= r.end || el.currentTime < r.start - 0.05)) el.currentTime = r.start;
      setHead(el.currentTime);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [video]);

  useEffect(() => {
    const el = preview.current;
    if (!el || !video) return;
    if (playing && working === null) void el.play().catch(() => setPlaying(false));
    else el.pause();
  }, [playing, video, working]);

  if (!video) return null; // still opening: an error closes the dialog before it ever shows

  const duration = video.duration;
  const pct = (s: number): string => `${(s / duration) * 100}%`;
  const timeAt = (clientX: number): number => {
    const box = track.current?.getBoundingClientRect();
    if (!box || box.width === 0) return 0;
    return Math.min(duration, Math.max(0, ((clientX - box.left) / box.width) * duration));
  };
  /** Shows the frame at the edge being moved, so the user sees where the clip starts or ends. */
  const show = (s: number) => {
    if (preview.current) preview.current.currentTime = s;
  };
  const apply = (kind: Drag['kind'], next: ClipRange) => {
    setRange(next);
    show(kind === 'end' ? next.end : next.start);
  };

  const down = (kind: Drag['kind']) => (e: PointerEvent<HTMLDivElement>) => {
    if (working !== null) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { kind, from: timeAt(e.clientX), range };
    preview.current?.pause();
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const at = timeAt(e.clientX);
    if (d.kind === 'start') apply('start', dragStart(d.range, at, duration));
    else if (d.kind === 'end') apply('end', dragEnd(d.range, at, duration));
    else apply('clip', dragClip(d.range, at - d.from, duration));
  };
  const up = () => {
    if (!drag.current) return;
    drag.current = null;
    show(rangeNow.current.start);
    if (playing && working === null) void preview.current?.play().catch(() => setPlaying(false));
  };
  // A click on the track outside the clip moves the clip so it starts there.
  const jump = (e: PointerEvent<HTMLDivElement>) => {
    if (working !== null) return;
    apply('clip', dragClip(range, timeAt(e.clientX) - range.start, duration));
  };
  const key = (kind: 'start' | 'end') => (e: KeyboardEvent<HTMLDivElement>) => {
    const step = (e.shiftKey ? 1 : STEP_S) * (e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0);
    if (step === 0 || working !== null) return;
    e.preventDefault();
    apply(kind, kind === 'start' ? dragStart(range, range.start + step, duration) : dragEnd(range, range.end + step, duration));
  };

  const withSound = keepSound && !!sound;
  const add = () => {
    setWorking(0);
    void prepareClip(file.name, video, range, withSound && sound ? sound : null, scale, (p) => setWorking(p)).then((r) => done.current(r));
  };
  const length = range.end - range.start;
  const edge = (kind: 'start' | 'end') => (
    <div className={`clipHandle ${kind}`} style={{ left: pct(range[kind]) }} role="slider" tabIndex={0}
      aria-label={kind === 'start' ? t.clipStart : t.clipEnd} aria-valuemin={0} aria-valuemax={duration}
      aria-valuenow={range[kind]} aria-valuetext={formatClock(range[kind])}
      onPointerDown={down(kind)} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key(kind)} />
  );

  return (
    <Dialog open modalType="modal" onOpenChange={(_, d) => !d.open && working === null && done.current(null)}>
      <DialogSurface style={{ width: 'min(640px, calc(100vw - 32px))', maxWidth: 'none' }}>
        <DialogBody>
          <DialogTitle>{t.clipTitle}</DialogTitle>
          <DialogContent className="clipBody">
            <span className="desc">{t.clipDesc}</span>
            <video ref={preview} className="clipPreview" src={video.url} muted={!withSound} playsInline
              onClick={() => setPlaying((p) => !p)} />
            <div className="clipControls">
              <Button appearance="subtle" icon={playing ? <Pause24Regular /> : <Play24Regular />}
                aria-label={playing ? t.clipPause : t.clipPlay} disabled={working !== null} onClick={() => setPlaying((p) => !p)} />
              <div ref={track} className="clipTrack" onPointerDown={jump}>
                <div className="clipSel" style={{ left: pct(range.start), width: pct(length) }}
                  onPointerDown={down('clip')} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
                {edge('start')}
                {edge('end')}
                <div className="clipHead" style={{ left: pct(head) }} />
              </div>
            </div>
            <span className="clipTimes">{t.clipRange(formatClock(range.start), formatClock(range.end), length.toFixed(1))}</span>
            <SizeSlider scale={scale} {...clipArtSize(video.width, video.height)} disabled={working !== null} onChange={setScale} />
            <Switch checked={withSound} disabled={!sound || working !== null} onChange={(_, d) => setKeepSound(d.checked)}
              label={sound === undefined ? t.clipReadingSound : sound === null ? t.clipNoSound : t.clipSound} />
          </DialogContent>
          <DialogActions>
            {working !== null ? <span className="clipWorking"><Spinner size="tiny" /> {t.clipWorking(Math.round(working * 100))}</span> : null}
            <Button disabled={working !== null} onClick={() => done.current(null)}>{t.clipCancel}</Button>
            <Button appearance="primary" disabled={working !== null || sound === undefined} onClick={add}>{t.clipAdd}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
