// adapters.js M5：調查／殘響鍵自動選可用的免費探索標籤（借聲、換影），並回報用了哪個標籤（畫面演出用）。
import { describe, it, expect } from 'vitest';
import { loadDir, M5_FIXTURE_DIR } from './load-fixture.js';
import { investigateFacing, echoFacing } from '../../web/src/adapters.js';

const data = loadDir(M5_FIXTURE_DIR);
const room = data.maps.find((m) => m.id === 'fx_room');
const at = (x, y, dir, o = {}) => ({
  schema_version: 4, player: { name: '艾琳' }, lineage: { id: 'trace', rank: 9 }, location: { map: 'fx_room', x, y, dir },
  flags: {}, items: {}, echo: { charges: 0 }, collapse: 0, resonance: {}, chapter: 'fx_ch4', chapter_done: [], playtime_s: 0,
  party: [{ id: 'hero', hp: null, sp: null }], ammo: 0, pending: null, dream_return: null, promotions: [], ending: null, ...o,
});
// 借聲門在 (7,1)：從 (7,2) 面向上；換影門在 (8,4)：從 (7,4) 面向右
const voiceDoor = (o) => at(7, 2, 'up', o);
const shadowDoor = (o) => at(7, 4, 'right', o);

describe('調查：解鎖時回報用了哪個探索標籤', () => {
  it('階 8 有 voice → 調查借聲門以 voice 解開，unlock.tag＝voice', () => {
    const r = investigateFacing(room, voiceDoor({ lineage: { id: 'trace', rank: 8 } }), data);
    expect(r.state.flags.fx5_voice_open).toBe(true);
    expect(r.dialogues).toEqual(['dlg_fx5_voice_open']);
    expect(r.unlock).toEqual({ tag: 'voice' });
  });
  it('階 9 沒有 voice → 鎖著，unlock 為 null', () => {
    const r = investigateFacing(room, voiceDoor(), data);
    expect(r.state.flags.fx5_voice_open).toBeUndefined();
    expect(r.dialogues).toEqual(['dlg_fx5_voice_locked']);
    expect(r.unlock).toBeNull();
  });
  it('用道具解開時 unlock 為 null（不是標籤）', () => {
    const r = investigateFacing(room, voiceDoor({ items: { old_key: 1 } }), data);
    expect(r.state.flags.fx5_voice_open).toBe(true);
    expect(r.unlock).toBeNull();
  });
});

describe('殘響鍵（解鎖鍵）：鎖不吃 trace 時，自動改用可用的免費標籤', () => {
  it('階 7 對換影門按殘響 → 以 shadow 解開（不扣殘響、不加崩解）', () => {
    const s = shadowDoor({ lineage: { id: 'trace', rank: 7 } });
    const r = echoFacing(room, s, data);
    expect(r.state.flags.fx5_shadow_open).toBe(true);
    expect(r.dialogues).toEqual(['dlg_fx5_shadow_open']);
    expect(r.unlock).toEqual({ tag: 'shadow' });
    expect(r.state.collapse).toBe(0);
  });
  it('沒有能用的標籤 → 照舊（沒有殘留痕跡）', () => {
    const r = echoFacing(room, shadowDoor({ lineage: { id: 'trace', rank: 8 } }), data);
    expect(r.state.flags.fx5_shadow_open).toBeUndefined();
    expect(r.message).toBe('沒有殘留痕跡');
    expect(r.unlock ?? null).toBeNull();
  });
  it('有鑰匙也不會用殘響鍵開（殘響鍵只用標籤）', () => {
    const r = echoFacing(room, shadowDoor({ items: { old_key: 1 } }), data);
    expect(r.state.flags.fx5_shadow_open).toBeUndefined();
  });
});
