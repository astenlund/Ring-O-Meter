// web/src/main.tsx
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './App';
import {shouldRenderLab} from './lab/ui/labGate';
import './index.css';

const root = createRoot(document.getElementById('root')!);

// The dev-only /lab route is dynamically imported inside the DEV guard so the lab
// module graph (web/src/lab/**) is dead-code-eliminated from production bundles:
// Vite replaces import.meta.env.DEV with the literal false in prod, dropping the
// whole branch and its dynamic import.
if (import.meta.env.DEV && shouldRenderLab(true, window.location.pathname)) {
    void import('./lab/ui/Lab').then(({Lab}) => {
        root.render(<StrictMode><Lab /></StrictMode>);
    });
} else {
    root.render(<StrictMode><App /></StrictMode>);
}
