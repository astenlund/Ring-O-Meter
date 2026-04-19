import {useEffect, useRef} from 'react';

export interface TraceSample {
    tsMs: number;
    fundamentalHz: number;
    confidence: number;
}

export interface PitchPlotProps {
    voiceLabels: Record<string, string>;     // channelId -> label
    voiceColors: Record<string, string>;     // channelId -> css color
    samples: Record<string, TraceSample[]>;  // channelId -> rolling buffer
    windowMs?: number;                       // default 10_000
    minHz?: number;                          // default 80
    maxHz?: number;                          // default 600
}

export function PitchPlot({
    voiceLabels,
    voiceColors,
    samples,
    windowMs = 10_000,
    minHz = 80,
    maxHz = 600,
}: PitchPlotProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            return;
        }

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

        const nowMs = performance.now();
        const startMs = nowMs - windowMs;

        Object.entries(samples).forEach(([channelId, trace]) => {
            const color = voiceColors[channelId] ?? '#fff';
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.beginPath();
            let pen = false;
            for (const s of trace) {
                if (s.tsMs < startMs || s.fundamentalHz <= 0 || s.confidence < 0.5) {
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
        });

        // Legend
        let legendY = 12;
        ctx.font = '12px sans-serif';
        Object.entries(voiceLabels).forEach(([channelId, label]) => {
            const color = voiceColors[channelId] ?? '#fff';
            ctx.fillStyle = color;
            ctx.fillRect(8, legendY - 8, 12, 12);
            ctx.fillStyle = '#ccc';
            ctx.fillText(label, 26, legendY + 2);
            legendY += 18;
        });
    }, [samples, voiceLabels, voiceColors, windowMs, minHz, maxHz]);

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
