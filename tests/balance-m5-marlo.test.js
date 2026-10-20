// M5 平衡（P8）：第四～七章每場戰鬥，第七章隊伍＝主角＋艾妲＋馬洛（第六章照實陳述、站在隊長這邊）。方法見 tests/lib/balance-m5-suite.js。
import { balanceSuite } from './lib/balance-m5-suite.js';

balanceSuite({
  team: 'marlo',
  encounters: [
    'enc_ch4_alley', 'enc_ch4_cloister_1', 'enc_ch4_cloister_2', 'enc_ch4_boss',
    'enc_ch5_entry', 'enc_ch5_canal_1', 'enc_ch5_canal_2', 'enc_ch5_canal_3', 'enc_ch5_cistern_1', 'enc_ch5_cistern_2', 'enc_ch5_boss',
    'enc_ch6_lane_1', 'enc_ch6_lane_boss',
    'enc_ch7_harbor_1', 'enc_ch7_harbor_2', 'enc_ch7_breakwater', 'enc_ch7_lighthouse_1', 'enc_ch7_priest', 'enc_ch7_omen',
  ],
  heeded: ['enc_ch7_omen', 'enc_ch7_omen_heeded'],
});
