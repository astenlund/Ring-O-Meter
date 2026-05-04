// Interface for a render module hosted by plotWorkerWebgpu's render
// system. The worker owns the GPU device, queue, command encoder, and
// canvas-context lifecycle; modules own their pipelines, buffers, and
// per-frame draw logic. One submit per frame; modules write into a
// shared GPURenderPassEncoder rather than creating their own.
//
// The pattern: each module's draw() is invoked inside whichever render
// pass targets that module's canvas. Modules attached to different
// canvases run in different passes within the same encoder, so the
// frame stays one CPU-side begin/end + one queue.submit regardless of
// module count.

export interface RenderModule {
    // Initialize GPU resources. Called once after device + queue + format
    // are ready. Modules should NOT create canvas contexts here - the
    // worker host owns canvas lifecycle. The format comes from the host's
    // devicePromise so all modules in one worker share the same swap-chain
    // format without each independently calling getPreferredCanvasFormat().
    init(device: GPUDevice, queue: GPUQueue, format: GPUTextureFormat): void;

    // Per-frame state update from CPU side. Called before draw().
    // Module reads its data sources (SAB rings, etc.) here, computes
    // anything CPU-side, and updates GPU buffers via queue.writeBuffer.
    // Receives the wall-clock dt in ms for animation/timing logic.
    update(dtMs: number): void;

    // Per-frame draw. Receives a pre-opened render pass encoder
    // targeting this module's canvas. Module sets pipeline, binds
    // buffers, issues draw calls. MUST NOT call passEncoder.end().
    draw(passEncoder: GPURenderPassEncoder): void;

    // Tear down GPU resources. Called when the worker is disposed or
    // the module is detached.
    dispose(): void;
}
