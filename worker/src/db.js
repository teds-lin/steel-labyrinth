// D1 用量計量：包裝 env.DB，累計一次請求的 rows_read／rows_written（D1 回傳的 meta）。
// 只用 all()／run()／batch()（first() 拿不到 meta，改用 all() 取第一列，語意相同）。
// 開啟 D1_METRICS=1（只在測試）時，回應會帶 x-d1-rows 標頭，讓測試斷言「超額請求寫入 0 列」等成本上限。

class MeteredStatement {
  constructor(meter, stmt) {
    this.meter = meter;
    this.stmt = stmt;
  }

  bind(...args) {
    return new MeteredStatement(this.meter, this.stmt.bind(...args));
  }

  async all() {
    const r = await this.stmt.all();
    this.meter.add(r.meta);
    return r;
  }

  async run() {
    const r = await this.stmt.run();
    this.meter.add(r.meta);
    return r;
  }

  async first() {
    const r = await this.all();
    return r.results.length ? r.results[0] : null;
  }
}

export class MeteredDb {
  constructor(db) {
    this.db = db;
    this.read = 0;
    this.written = 0;
  }

  add(meta) {
    this.read += Number(meta?.rows_read ?? 0);
    this.written += Number(meta?.rows_written ?? 0);
  }

  prepare(sql) {
    return new MeteredStatement(this, this.db.prepare(sql));
  }

  async batch(stmts) {
    const rs = await this.db.batch(stmts.map((s) => (s instanceof MeteredStatement ? s.stmt : s)));
    for (const r of rs) this.add(r.meta);
    return rs;
  }

  header() {
    return `read=${this.read}; written=${this.written}`;
  }
}
