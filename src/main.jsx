// src/main.jsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { registerServiceWorker } from './lib/push.js';
import './styles.css';

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
// Makes Novi installable and lets phone notifications reach it.
registerServiceWorker();
