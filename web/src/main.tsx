// web/src/main.tsx
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './App';
import {shouldRenderLab} from './lab/ui/labGate';
import './index.css';

const root = createRoot(document.getElementById('root')!);

// The outer import.meta.env.DEV guard is the DCE trigger: Vite replaces it with
// the literal false in prod, dropping the whole branch and its dynamic import so
// the lab module graph (web/src/lab/**) is never bundled into production.
// shouldRenderLab makes the actual routing decision inside the guard.
if (import.meta.env.DEV && shouldRenderLab(import.meta.env.DEV, window.location.pathname)) {
    void import('./lab/ui/Lab').then(({Lab}) => {
        root.render(<StrictMode><Lab /></StrictMode>);
    });
} else {
    root.render(<StrictMode><App /></StrictMode>);
}
