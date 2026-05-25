// Whether to render the dev-only lab instead of the main app. Pure so main.tsx's
// gate is testable. The caller pairs this with a dynamic import of Lab so the lab
// module graph is dead-code-eliminated from production bundles.

export function shouldRenderLab(isDev: boolean, pathname: string): boolean {
    return isDev && pathname === '/lab';
}
