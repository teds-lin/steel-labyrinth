// 本機開發用的靜態伺服器（只服務 web/）。
// 任何請求都不可以讓伺服器退出：壞掉的 URL 回 400，跳出 web/ 的路徑回 403，找不到回 404。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../web/', import.meta.url)));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
const port = Number(process.env.PORT || 8080);

function send(res, code, msg) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(msg);
}

/** 把請求路徑轉成 web/ 底下的絕對路徑；不合法回 { code }。 */
function resolveRequest(rawUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(rawUrl, 'http://x').pathname);
  } catch {
    return { code: 400 };
  }
  if (pathname.includes('\0')) return { code: 400 };
  // 反斜線一律當成路徑分隔，避免 Windows 上 ..\ 跳出去
  const rel = pathname.replace(/\\/g, '/');
  const file = resolve(root, `.${rel.startsWith('/') ? '' : '/'}${rel}`);
  if (file !== root && !file.startsWith(root + sep)) return { code: 403 };
  return { file: rel.endsWith('/') || file === root ? resolve(file, 'index.html') : file };
}

createServer(async (req, res) => {
  try {
    const r = resolveRequest(req.url ?? '/');
    if (r.code) { send(res, r.code, r.code === 400 ? 'bad request' : 'forbidden'); return; }
    const body = await readFile(r.file);
    res.writeHead(200, { 'content-type': types[extname(r.file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    if (!res.headersSent) send(res, 404, 'not found');
    else res.end();
  }
}).listen(port, () => console.log(`http://localhost:${port}/`));
