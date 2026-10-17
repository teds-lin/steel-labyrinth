// API 位址解析（web/src/cloud/endpoint.js）：預設空字串＝雲端停用（修訂 2 G 節）；?api= 只在本機開發時生效，避免連結把權杖送到別的伺服器。
import { describe, it, expect } from 'vitest';
import { API_BASE_DEFAULT, resolveApiBase, cloudConfigured } from '../../web/src/cloud/endpoint.js';

describe('resolveApiBase', () => {
  it('預設是空字串（雲端存檔尚未開放）', () => {
    expect(API_BASE_DEFAULT).toBe('');
    expect(resolveApiBase('', 'teds-lin.github.io')).toBe('');
    expect(resolveApiBase('?test=1', 'localhost')).toBe('');
    expect(cloudConfigured('')).toBe(false);
    expect(cloudConfigured('http://localhost:8787')).toBe(true);
  });
  it('頁面在本機時 ?api= 可覆寫（去掉結尾斜線）', () => {
    expect(resolveApiBase('?api=http://localhost:8787/', 'localhost')).toBe('http://localhost:8787');
    expect(resolveApiBase('?test=1&api=https%3A%2F%2Fstaging.example.dev', '127.0.0.1')).toBe('https://staging.example.dev');
    expect(resolveApiBase('?api=http://localhost:8091/mock', '[::1]')).toBe('http://localhost:8091/mock');
  });
  it('正式頁面只接受指向本機的 ?api=（線上 E2E 接本機 Worker）', () => {
    expect(resolveApiBase('?api=http://127.0.0.1:8787', 'teds-lin.github.io')).toBe('http://127.0.0.1:8787');
    expect(resolveApiBase('?api=https://evil.example', 'teds-lin.github.io')).toBe(API_BASE_DEFAULT);
  });
  it('不合法的網址、非 http(s)、帶帳密 → 預設', () => {
    for (const bad of ['?api=javascript:alert(1)', '?api=ftp://localhost', '?api=not a url', '?api=', '?api=http://u:p@localhost:1']) {
      expect(resolveApiBase(bad, 'localhost'), bad).toBe(API_BASE_DEFAULT);
    }
    expect(resolveApiBase(null, null)).toBe(API_BASE_DEFAULT);
  });
});
