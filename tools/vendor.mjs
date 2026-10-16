// 把 node_modules 裡的 Phaser 複製到 web/vendor/，讓 GitHub Pages 不依賴 CDN。
import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('web/vendor', { recursive: true });
copyFileSync('node_modules/phaser/dist/phaser.min.js', 'web/vendor/phaser.min.js');
console.log('已複製 phaser.min.js 到 web/vendor/');
