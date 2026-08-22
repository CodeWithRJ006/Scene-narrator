/**
 * main.js – Application entry point.
 *
 * Imports styles and bootstraps the App when the DOM is ready.
 */

import './ui/styles/main.css';
import './ui/styles/components.css';
import { App } from './App.js';

document.addEventListener('DOMContentLoaded', () => {
    new App();
});
