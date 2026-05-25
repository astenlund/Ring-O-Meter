// web/src/lab/ui/labAudioPlayer.ts
// Plays two pre-rendered, seamless-loop A/B variant buffers and crossfades between
// them on demand. Both sources start together and loop continuously; the A/B toggle
// gates which one reaches output via a short equal-power crossfade so the switch is
// click-free and lands at the same playback offset (spec section "### Band 2").
// Play/Pause drives the AudioContext run state. erasableSyntaxOnly: fields declared,
// assigned in the constructor body (no parameter properties).

import {equalPowerGains} from './equalPower';

const AB_CROSSFADE_S = 0.01; // 10 ms equal-power A/B switch

const STEPS = 16;

export type AbSide = 'A' | 'B';

export class LabAudioPlayer {
    active: AbSide;

    private readonly ctx: AudioContext;
    private readonly srcA: AudioBufferSourceNode;
    private readonly srcB: AudioBufferSourceNode;
    private readonly gainA: GainNode;
    private readonly gainB: GainNode;
    private readonly risingCurve: Float32Array;
    private readonly fallingCurve: Float32Array;
    private started: boolean;

    constructor(ctx: AudioContext, bufferA: AudioBuffer, bufferB: AudioBuffer) {
        this.ctx = ctx;
        this.active = 'A';
        this.started = false;

        this.risingCurve = new Float32Array(STEPS + 1);
        this.fallingCurve = new Float32Array(STEPS + 1);
        for (let i = 0; i <= STEPS; i++) {
            const [falling, rising] = equalPowerGains(i / STEPS);
            this.fallingCurve[i] = falling;
            this.risingCurve[i] = rising;
        }

        this.srcA = ctx.createBufferSource();
        this.srcB = ctx.createBufferSource();
        this.srcA.buffer = bufferA;
        this.srcB.buffer = bufferB;
        this.srcA.loop = true;
        this.srcB.loop = true;

        this.gainA = ctx.createGain();
        this.gainB = ctx.createGain();
        this.gainA.gain.value = 1; // A starts audible
        this.gainB.gain.value = 0;

        this.srcA.connect(this.gainA).connect(ctx.destination);
        this.srcB.connect(this.gainB).connect(ctx.destination);
    }

    // Returns whether audio is actually running afterward, so the caller can surface
    // the audio-unavailable state when a resume is blocked by autoplay policy.
    async play(): Promise<boolean> {
        if (!this.started) {
            // Start both at the same instant so they stay phase-locked for switching.
            const when = this.ctx.currentTime;
            this.srcA.start(when);
            this.srcB.start(when);
            this.started = true;
        }
        if (this.ctx.state === 'suspended') {
            await this.ctx.resume();
        }

        return this.ctx.state === 'running';
    }

    async pause(): Promise<void> {
        if (this.ctx.state === 'running') {
            await this.ctx.suspend();
        }
    }

    setActive(side: AbSide): void {
        if (side === this.active) {
            return;
        }
        this.active = side;
        const now = this.ctx.currentTime;
        const aCurve = side === 'A' ? this.risingCurve : this.fallingCurve;
        const bCurve = side === 'A' ? this.fallingCurve : this.risingCurve;
        this.gainA.gain.cancelScheduledValues(now);
        this.gainA.gain.setValueCurveAtTime(aCurve, now, AB_CROSSFADE_S);
        this.gainB.gain.cancelScheduledValues(now);
        this.gainB.gain.setValueCurveAtTime(bCurve, now, AB_CROSSFADE_S);
    }

    dispose(): void {
        for (const src of [this.srcA, this.srcB]) {
            try {
                src.stop();
            } catch {
                // Already stopped or never started; safe to ignore.
            }
            src.disconnect();
        }
        this.gainA.disconnect();
        this.gainB.disconnect();
    }
}
