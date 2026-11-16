import html from './page.html?raw';
import '../_shared/console.css';
import './style.css';
import { start } from './ui.js';
document.getElementById('app')!.innerHTML = html;
void start();
