// A worker that never answers (tests the reader's time limit).
import { parentPort } from 'node:worker_threads';
parentPort.on('message', () => { /* never answers */ });
