import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Slider,
} from '@fluentui/react-components';
import { useEffect, useRef, useState } from 'react';
import { EMOTE_SCALE_MAX, EMOTE_SCALE_MIN, EMOTE_SCALE_STEP, scaledArtSize, type EmoteFile } from '../../../shared/emotes';
import { imageSize, sniffImage } from '../../../shared/imageSniff';
import { useText } from '../text';

/**
 * The size row both import dialogs share: a slider from EMOTE_SCALE_MIN to EMOTE_SCALE_MAX percent of the art's own
 * size, and what that comes to in px.
 */
export function SizeSlider({ scale, width, height, disabled, onChange }: {
  scale: number; width: number; height: number; disabled?: boolean; onChange(scale: number): void;
}) {
  const t = useText();
  const shown = scaledArtSize(width, height, scale);
  return (
    <div className="sizeRow">
      <span className="sizeLabel">{t.emoteScale}</span>
      <Slider min={EMOTE_SCALE_MIN} max={EMOTE_SCALE_MAX} step={EMOTE_SCALE_STEP} value={scale} disabled={disabled}
        aria-label={t.emoteScale} aria-valuetext={t.emoteScaleValue(scale, shown.w, shown.h)}
        onChange={(_, d) => onChange(d.value)} />
      <span className="sizeValue">{t.emoteScaleValue(scale, shown.w, shown.h)}</span>
    </div>
  );
}

/**
 * The dialog an added image opens before it becomes an emote: the image at the size it will show, for us and for room
 * members, and the slider that sets it. `onDone` gets the file with the chosen scale, or null when cancelled, and
 * nothing is saved until then.
 */
export function EmoteSizer({ file, onDone }: { file: EmoteFile; onDone(result: EmoteFile | null): void }) {
  const t = useText();
  const [scale, setScale] = useState(100);
  const [url, setUrl] = useState<string | null>(null);
  const [room, setRoom] = useState<{ w: number; h: number } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const art = file.anim ?? file.still;
  const own = imageSize(art) ?? { width: 160, height: 160 };

  useEffect(() => {
    const type = sniffImage(art);
    const next = URL.createObjectURL(new Blob([art.slice()], { type: `image/${type ?? 'webp'}` }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [art]);

  // How much room the preview has: the image shows at its real size when it fits, and scaled down to fit when not.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setRoom({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [url]);

  const shown = scaledArtSize(own.width, own.height, scale);
  const fit = room ? Math.min(1, room.w / shown.w, room.h / shown.h) : 1;

  return (
    <Dialog open modalType="modal" onOpenChange={(_, d) => !d.open && onDone(null)}>
      <DialogSurface style={{ width: 'min(640px, calc(100vw - 32px))', maxWidth: 'none' }}>
        <DialogBody>
          <DialogTitle>{t.sizeTitle(file.name)}</DialogTitle>
          <DialogContent className="sizeBody">
            <span className="desc">{t.sizeDesc}</span>
            <div ref={stage} className="sizeStage">
              {url ? <img src={url} alt="" style={{ width: shown.w * fit, height: shown.h * fit }} /> : null}
            </div>
            {fit < 1 ? <span className="sizeNote">{t.sizeSmaller}</span> : null}
            <SizeSlider scale={scale} width={own.width} height={own.height} onChange={setScale} />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => onDone(null)}>{t.clipCancel}</Button>
            <Button appearance="primary" onClick={() => onDone({ ...file, scale })}>{t.clipAdd}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
