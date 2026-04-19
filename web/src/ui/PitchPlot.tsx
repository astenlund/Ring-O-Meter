import {type RefObject, useEffect, useRef} from 'react';
import {MIN_DISPLAY_CONFIDENCE} from './formatPitch';

export interface TraceSample {
    tsMs: number;
    fundamentalHz: number;
    confidence: number;
}

export interface VoiceStyle {
    label: string;
    color: string;
}

export interface PitchPlotProps {
    voices: Record<string, VoiceStyle>;          // channelId -> label + color
    samplesRef: RefObject<Record<string, TraceSample[]>>;
    windowMs: number;                            // rolling display window
    minHz?: number;                              // default 80
    maxHz?: number;                              // default 600
}

export function PitchPlot({
    voices,
    samplesRef,
    windowMs,
    minHz = 80,
    maxHz = 600,
}: PitchPlotProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    // The trace buffer updates at the worklet's publish rate (~47 Hz per
    // voice). Painting once per animation frame (<=60 Hz, zero when the tab
    // is hidden) decouples the paint rate from publish rate and lets the
    // browser coalesce work with other rendering. The loop reads samplesRef
    // directly so trace pushes don't need to cause React re-renders.
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            return;
        }

        let rafId = 0;

        const paint = () => {
            const dpr = window.devicePixelRatio || 1;
            const width = canvas.clientWidth;
            const height = canvas.clientHeight;
            if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
                canvas.width = width * dpr;
                canvas.height = height * dpr;
            }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            ctx.clearRect(0, 0, width, height);
            ctx.fillStyle = '#111';
            ctx.fillRect(0, 0, width, height);

            // Grid
            ctx.strokeStyle = '#222';
            ctx.lineWidth = 1;
            for (let f = minHz; f <= maxHz; f += 50) {
                const y = hzToY(f, minHz, maxHz, height);
                ctx.beginPath();
                ctx.moveTo(0, y);
                ctx.lineTo(width, y);
                ctx.stroke();
            }

            const samples = samplesRef.current ?? {};
            const nowMs = performance.now();
            const startMs = nowMs - windowMs;

            // Iterate voices (not samples) so legend and trace order stay in
            // sync even if a sample buffer exists for a channel that is no
            // longer in the voice set (or vice versa).
            for (const [channelId, voice] of Object.entries(voices)) {
                const trace = samples[channelId] ?? [];
                ctx.strokeStyle = voice.color;
                ctx.lineWidth = 2;
                ctx.beginPath();
                let pen = false;
                for (const s of trace) {
                    if (s.tsMs < startMs || s.fundamentalHz <= 0 || s.confidence < MIN_DISPLAY_CONFIDENCE) {
                        pen = false;
                        continue;
                    }
                    const x = ((s.tsMs - startMs) / windowMs) * width;
                    const y = hzToY(s.fundamentalHz, minHz, maxHz, height);
                    if (!pen) {
                        ctx.moveTo(x, y);
                        pen = true;
                    } else {
                        ctx.lineTo(x, y);
                    }
                }
                ctx.stroke();
            }

            // Legend (same iteration order as traces)
            let legendY = 12;
            ctx.font = '12px sans-serif';
            for (const voice of Object.values(voices)) {
                ctx.fillStyle = voice.color;
                ctx.fillRect(8, legendY - 8, 12, 12);
                ctx.fillStyle = '#ccc';
                ctx.fillText(voice.label, 26, legendY + 2);
                legendY += 18;
            }

            rafId = requestAnimationFrame(paint);
        };

        rafId = requestAnimationFrame(paint);

        return () => cancelAnimationFrame(rafId);
    }, [voices, samplesRef, windowMs, minHz, maxHz]);

    return (
        <canvas
            ref={canvasRef}
            style={{width: '100%', height: 360, borderRadius: 6, border: '1px solid #444'}}
        />
    );
}

function hzToY(hz: number, minHz: number, maxHz: number, height: number): number {
    const logMin = Math.log(minHz);
    const logMax = Math.log(maxHz);
    const t = (Math.log(hz) - logMin) / (logMax - logMin);

    return height - t * height;
}
