import { createWebPlatform } from '../platform/web.js';
import { renderApp } from './render.js';

export function start() { renderApp(createWebPlatform({ version: __APP_VERSION__ })); }
