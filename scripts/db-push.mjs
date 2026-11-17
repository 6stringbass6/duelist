// 사용: npm run db:push [-- --dry | --baseline | --schema | --file x.sql | --force]
// 루트의 supabase_*.sql 증분 파일을 원격 DB 에 적용. 적용 이력은 public._applied_sql 에 sha256 으로 기록(내용이 바뀌면 재적용).
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import { fileURLToPath } from 'node:url';
import pg from 'pg';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), has = (f) => args.includes(f);
const url = process.env.SUPABASE_DB_URL;
if (!url || /<DB_PASSWORD>|<PROJECT_REF>/.test(url)) { console.error('SUPABASE_DB_URL 이 없습니다. .env.local 에 설정하세요 (.env.local.example 참고).'); process.exit(2); }
const fi = args.indexOf('--file');
let files = fi >= 0 ? [args[fi + 1]] : fs.readdirSync(root).filter((f) => /^supabase_.*\.sql$/.test(f) && (has('--schema') || f !== 'supabase_schema.sql')).sort();
if (has('--schema') && fi < 0) files = ['supabase_schema.sql', ...files.filter((f) => f !== 'supabase_schema.sql')];
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query('create table if not exists public._applied_sql (name text primary key, sha text not null, applied_at timestamptz not null default now())');
  await client.query('alter table public._applied_sql enable row level security'); // 정책 없음 = API 접근 불가
  const done = new Map((await client.query('select name, sha from public._applied_sql')).rows.map((r) => [r.name, r.sha]));
  let n = 0;
  for (const f of files) {
    const sql = fs.readFileSync(path.join(root, f), 'utf8'), sha = crypto.createHash('sha256').update(sql).digest('hex');
    if (!has('--force') && done.get(f) === sha) { console.log(`= ${f} (이미 적용됨)`); continue; }
    if (has('--dry')) { console.log(`+ ${f} (적용 예정)`); n++; continue; }
    if (!has('--baseline')) {
      try { await client.query('begin'); await client.query(sql); await client.query('commit'); }
      catch (err) { await client.query('rollback').catch(() => {}); console.error(`✗ ${f} 실패(롤백됨): ${err.message}${err.position ? ` (위치 ${err.position})` : ''}`); process.exitCode = 1; break; }
    }
    await client.query('insert into public._applied_sql(name, sha) values ($1,$2) on conflict (name) do update set sha = $2, applied_at = now()', [f, sha]);
    console.log(`${has('--baseline') ? '○ 기록만' : '✓ 적용'}: ${f}`); n++;
  }
  if (!has('--dry') && !has('--baseline') && n && !process.exitCode) { await client.query("notify pgrst, 'reload schema'"); console.log('PostgREST 스키마 캐시 갱신 요청 완료'); }
  console.log(n ? `완료 (${n}개)` : '적용할 변경 없음');
} finally { await client.end(); }
