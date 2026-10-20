// M5 整合：畫面工程師建議的引擎改進（晉升 pending、investigate 回報解鎖方式、殘響鍵的免費標籤規則移進 core、
// 禁聲狀態 silence、end_screen.credits、lineage rank 的 field_labels）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadDir, M5_FIXTURE_DIR } from '../ui/load-fixture.js';
import { applyEffect, takePending } from '../../web/src/core/effects.js';
import { investigate, echo } from '../../web/src/core/interact.js';
import { validateBundle } from '../../web/src/core/validate.js';
import { BATTLE_STATUSES } from '../../web/src/core/battle/stat.js';
import { startBattle, commands, act, advanceEnemy } from '../../web/src/core/battle/engine.js';
import { applyBattleEffect, statusChance } from '../../web/src/core/battle/effects.js';
import { decideIntent } from '../../web/src/core/battle/ai.js';

const data = loadDir(M5_FIXTURE_DIR);
const room = data.maps.find((m) => m.id === 'fx_room');
const obj = (id) => room.objects.find((o) => o.id === id);
const base = (o = {}) => ({
  schema_version: 4, player: { name: '艾琳' }, lineage: { id: 'trace', rank: 9 },
  location: { map: 'fx_room', x: 4, y: 3, dir: 'down' }, flags: {}, items: {}, echo: { charges: 0 }, collapse: 0,
  resonance: {}, chapter: 'fx_ch4', chapter_done: [], playtime_s: 0, party: [{ id: 'hero', hp: null, sp: null }],
  ammo: 0, pending: null, dream_return: null, promotions: [], ending: null, ...o,
});
const PROMOTE8 = { promote: { lineage: 'trace', rank: 8 } };

describe('晉升成功時寫入 pending { type: "promoted", lineage, rank, forced }', () => {
  it('共鳴足夠：promoted、forced false', () => {
    const s = applyEffect(PROMOTE8, base({ items: { echo_moss: 2, choir_wax: 1 }, resonance: { a: 12 } }), data);
    expect(takePending(s).pending).toEqual([{ type: 'promoted', lineage: 'trace', rank: 8, forced: false }]);
  });
  it('硬喝：promoted、forced true', () => {
    const s = applyEffect(PROMOTE8, base({ items: { echo_moss: 2, choir_wax: 1 } }), data);
    expect(takePending(s).pending).toEqual([{ type: 'promoted', lineage: 'trace', rank: 8, forced: true }]);
  });
  it('失敗（材料不足）只有 promote_failed，沒有 promoted', () => {
    const s = applyEffect(PROMOTE8, base(), data);
    expect(takePending(s).pending.map((p) => p.type)).toEqual(['promote_failed']);
  });
});

describe('investigate() 回傳 unlock: { via, tag }', () => {
  const door = obj('obj_fx5_voice_door');
  it('用探索標籤解開：{ via: "tag", tag: "voice" }', () => {
    const r = investigate(door, base({ lineage: { id: 'trace', rank: 8 } }), data);
    expect(r.unlock).toEqual({ via: 'tag', tag: 'voice' });
  });
  it('用道具解開：{ via: "item", tag: null }', () => {
    const r = investigate(door, base({ items: { old_key: 1 } }), data);
    expect(r.unlock).toEqual({ via: 'item', tag: null });
  });
  it('鎖著、已經解開、或不是鎖的物件：null', () => {
    expect(investigate(door, base(), data).unlock).toBeNull();
    expect(investigate(door, base({ flags: { fx5_voice_open: true } }), data).unlock).toBeNull();
    const plain = room.objects.find((o) => !o.lock);
    expect(investigate(plain, base(), data).unlock).toBeNull();
  });
  it('adapters.js 不再自己呼叫 tryUnlock（解鎖結果只來自 core）', () => {
    const src = readFileSync(fileURLToPath(new URL('../../web/src/adapters.js', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/tryUnlock/);
  });
});

describe('殘響鍵：鎖不吃 trace，但譜系的其他免費標籤解得開 → core 的 echo() 直接用那個標籤', () => {
  const door = obj('obj_fx5_shadow_door');
  it('階 7、殘響次數 0：以 shadow 解開，不扣次數、不加崩解，unlock { via:"tag", tag:"shadow" }', () => {
    const r = echo(door, base({ lineage: { id: 'trace', rank: 7 }, echo: { charges: 0 } }), data);
    expect(r.unlocked).toBe(true);
    expect(r.state.flags.fx5_shadow_open).toBe(true);
    expect(r.dialogue).toBe('dlg_fx5_shadow_open');
    expect(r.unlock).toEqual({ via: 'tag', tag: 'shadow' });
    expect(r.state.collapse).toBe(0);
  });
  it('沒有讀痕者譜系、只有暫時殘響：鎖不吃 trace → 不會用掉殘響（沒有殘留痕跡）', () => {
    const r = echo(door, base({ lineage: null, echo: { charges: 2 } }), data);
    expect(r.state.flags.fx5_shadow_open).toBeUndefined();
    expect(r.state.echo.charges).toBe(2);
  });
  it('有鑰匙也不會用殘響鍵開（殘響鍵只用標籤）', () => {
    const r = echo(door, base({ items: { old_key: 1 } }), data);
    expect(r.state.flags.fx5_shadow_open).toBeUndefined();
    expect(r.unlock ?? null).toBeNull();
  });
});

// ---------- 禁聲 ----------

const silenceData = () => {
  const d = structuredClone(data);
  d.skills.push(
    { id: 'zz_spell', name: '測試法術', target: 'enemy', cost: { sp: 3 }, effects: [{ type: 'damage', power: 100 }] },
    { id: 'zz_silence', name: '禁聲', target: 'enemy_all', effects: [{ type: 'status', status: 'silence', chance: 100, turns: 2 }] },
    { id: 'zz_enemy_spell', name: '敵人法術', target: 'enemy', cost: { sp: 5 }, effects: [{ type: 'damage', power: 100 }] },
  );
  const hero = d.characters.find((c) => c.id === 'hero');
  hero.skills = [...hero.skills, 'zz_spell'];
  d.items.push({ id: 'zz_bandage', name: '繃帶', target: 'ally', battle_effects: [{ type: 'heal', amount: 10 }] });
  d.enemies.push({ id: 'zz_mage', name: '術士', sprite: 'fogwalker', rank: 9, stats: { hp: 300, sp: 50, atk: 1, def: 0, spd: 1, will: 0, eva: 0 },
    skills: ['attack', 'zz_enemy_spell'], ai: [{ skill: 'zz_enemy_spell', weight: 100 }, { skill: 'attack', weight: 1 }] });
  d.encounters.push({ id: 'zz_enc', enemies: ['zz_mage'], bg: 'dock', can_flee: true });
  return d;
};

describe('禁聲 silence（戰鬥狀態）', () => {
  it('BATTLE_STATUSES 有 silence；validate 接受 status: silence', () => {
    expect(BATTLE_STATUSES).toContain('silence');
    const d = silenceData();
    expect(validateBundle(d).filter((e) => /zz_/.test(e))).toEqual([]);
  });
  const silenced = (d) => {
    const b = startBattle('zz_enc', base({ items: { zz_bandage: 1 } }), d, 1);
    const hero = b.units.find((u) => u.id === 'hero');
    hero.status.silence = 2;
    return b;
  };
  it('禁聲中：消耗靈性的技能不能用（reason silence），不耗靈性的技能與道具照常', () => {
    const d = silenceData();
    const c = commands(silenced(d), d);
    const sk = (id) => c.skills.find((s) => s.id === id);
    expect(sk('zz_spell')).toMatchObject({ usable: false, reason: 'silence' });
    expect(sk('attack').usable).toBe(true);
    expect(c.items.map((i) => i.id)).toContain('zz_bandage');
  });
  it('禁聲中用消耗靈性的技能 → 丟錯；道具可以用', () => {
    const d = silenceData();
    const b = silenced(d);
    const enemy = b.units.find((u) => u.side === 'enemy');
    expect(() => act(b, { type: 'skill', skill: 'zz_spell', target: enemy.uid }, d)).toThrow(/禁聲/);
    const hero = b.units.find((u) => u.id === 'hero');
    expect(() => act(b, { type: 'item', item: 'zz_bandage', target: hero.uid }, d)).not.toThrow();
  });
  it('機率受意志減免（敵對效果）：chance × 50 ÷ (50＋will)', () => {
    const d = silenceData();
    const b = startBattle('zz_enc', base(), d, 1);
    const hero = b.units.find((u) => u.id === 'hero');
    const enemy = b.units.find((u) => u.side === 'enemy');
    expect(statusChance(100, enemy, hero)).toBeLessThan(100);
    const r = applyBattleEffect(b, { type: 'status', status: 'silence', chance: 100, turns: 2 }, enemy.uid, hero.uid, d);
    expect(r.log[0].type).toMatch(/^status/);
  });
  it('敵人禁聲中：AI 不選消耗靈性的技能', () => {
    const d = silenceData();
    const b = startBattle('zz_enc', base(), d, 1);
    const enemy = b.units.find((u) => u.side === 'enemy');
    enemy.status.silence = 3;
    for (let i = 0; i < 20; i++) expect(decideIntent({ ...b, rng: { s: (b.rng.s + i * 7919) >>> 0 } }, enemy.uid, d).intent.skill).toBe('attack');
  });
  it('持續回合結束後解除：下一次輪到時可以再用技能', () => {
    const d = silenceData();
    let b = startBattle('zz_enc', base(), d, 1);
    const heroUid = b.units.find((u) => u.id === 'hero').uid;
    b.units.find((u) => u.id === 'hero').status.silence = 1;
    expect(commands(b, d).skills.find((s) => s.id === 'zz_spell').usable).toBe(false);
    const enemy = b.units.find((u) => u.side === 'enemy');
    b = act(b, { type: 'skill', skill: 'attack', target: enemy.uid }, d).battle;
    while (b.outcome === null && b.actor !== heroUid) b = advanceEnemy(b, d).battle;
    expect(commands(b, d).skills.find((s) => s.id === 'zz_spell').usable).toBe(true);
  });
});

// ---------- end_screen.credits、field_labels ----------

describe('validate：end_screen.credits 與 lineage rank 的 field_labels', () => {
  const mut = (f) => { const d = structuredClone(data); f(d); return validateBundle(d); };
  it('合法寫法不報錯', () => {
    expect(mut((d) => {
      d.story.find((s) => s.id === 'fx_finale').end_screen.credits = ['致謝', '劇本：某某'];
      d.lineages[0].ranks[1].field_labels = { voice: '借聲' };
    })).toEqual([]);
  });
  it('credits 必須是非空字串的陣列', () => {
    for (const bad of ['致謝', [], ['ok', ''], ['ok', 3]]) {
      const errs = mut((d) => { d.story.find((s) => s.id === 'fx_finale').end_screen.credits = bad; });
      expect(errs.some((e) => /credits/.test(e)), JSON.stringify(bad)).toBe(true);
    }
  });
  it('field_labels：值必須是非空字串、鍵必須是該階位 field 裡的標籤', () => {
    for (const bad of [['借聲'], { voice: '' }, { shadow: '換影' }, { voice: 3 }]) {
      const errs = mut((d) => { d.lineages[0].ranks[1].field_labels = bad; });
      expect(errs.some((e) => /field_labels/.test(e)), JSON.stringify(bad)).toBe(true);
    }
  });
});
