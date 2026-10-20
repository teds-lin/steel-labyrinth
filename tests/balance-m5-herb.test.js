// M5 平衡（P8）：第七章隊伍＝主角＋老賀伯＋艾妲（第六章簽下陳述舉報隊長）。第四～六章與另一條路線相同（見 balance-m5-marlo），
// 這裡只檢查第七章。方法見 tests/lib/balance-m5-suite.js。
import { balanceSuite } from './lib/balance-m5-suite.js';

balanceSuite({
  team: 'herb',
  encounters: ['enc_ch7_harbor_1', 'enc_ch7_harbor_2', 'enc_ch7_breakwater', 'enc_ch7_lighthouse_1', 'enc_ch7_priest', 'enc_ch7_omen_nocap'],
  heeded: ['enc_ch7_omen_nocap', 'enc_ch7_omen_heeded_nocap'],
});
