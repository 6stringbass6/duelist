// 사용: npm run deploy:status [-- --wait]  HEAD 커밋 푸시 여부 + Vercel/Render 배포 상태 확인 (--wait: 완료까지 폴링)
import { execSync } from 'node:child_process';
const env = process.env, wait = process.argv.includes('--wait');
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();
const sha = sh('git rev-parse HEAD'); let pushed = false;
try { sh('git fetch origin main -q'); pushed = sh(`git branch -r --contains ${sha}`).includes('origin/main'); } catch {}
console.log(`HEAD ${sha.slice(0, 7)} — origin/main ${pushed ? '푸시됨' : '미푸시 (git push 필요)'}`);
const j = async (u, h = {}) => { const r = await fetch(u, { headers: h }); if (!r.ok) throw new Error(`${r.status} ${u.split('?')[0]}`); return r.json(); };
const checks = [];
if (env.VERCEL_TOKEN && env.VERCEL_PROJECT_ID) checks.push(['Vercel', async () => {
  const q = `projectId=${env.VERCEL_PROJECT_ID}&limit=10${env.VERCEL_TEAM_ID ? `&teamId=${env.VERCEL_TEAM_ID}` : ''}`;
  const d = (await j(`https://api.vercel.com/v6/deployments?${q}`, { Authorization: `Bearer ${env.VERCEL_TOKEN}` })).deployments.find((x) => x.meta?.githubCommitSha === sha);
  return d ? { state: d.state, final: ['READY', 'ERROR', 'CANCELED'].includes(d.state), ok: d.state === 'READY', url: d.url } : { state: '아직 배포 생성 안 됨', final: false };
}]);
if (env.RENDER_API_KEY && env.RENDER_SERVICE_ID) checks.push(['Render', async () => {
  const d = (await j(`https://api.render.com/v1/services/${env.RENDER_SERVICE_ID}/deploys?limit=10`, { Authorization: `Bearer ${env.RENDER_API_KEY}` })).map((x) => x.deploy ?? x).find((x) => x.commit?.id === sha);
  return d ? { state: d.status, final: ['live', 'deactivated', 'build_failed', 'update_failed', 'canceled', 'pre_deploy_failed'].includes(d.status), ok: d.status === 'live' } : { state: '아직 배포 생성 안 됨', final: false };
}]);
if (!checks.length && env.GITHUB_REPO) checks.push(['GitHub 상태', async () => {
  const d = await j(`https://api.github.com/repos/${env.GITHUB_REPO}/commits/${sha}/status`, env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {});
  return { state: `${d.state} (${d.statuses.map((s) => `${s.context}:${s.state}`).join(', ') || '없음'})`, final: d.state !== 'pending', ok: d.state === 'success' };
}]);
if (!checks.length) { console.error('VERCEL_*/RENDER_* 또는 GITHUB_REPO 가 .env.local 에 필요합니다.'); process.exit(2); }
let fail = false;
for (const [name, fn] of checks) {
  for (let i = 0; ; i++) {
    let r; try { r = await fn(); } catch (e) { r = { state: `조회 실패: ${e.message}`, final: true, ok: false }; }
    console.log(`${name}: ${r.state}${r.url ? ` https://${r.url}` : ''}`);
    if (r.final || !wait || i > 60) { if (!r.ok) fail = true; break; }
    await new Promise((s) => setTimeout(s, 10000));
  }
}
if (env.SERVER_URL) { try { console.log('서버 /health:', JSON.stringify(await j(`${env.SERVER_URL.replace(/\/$/, '')}/health`))); } catch (e) { console.log(`서버 /health 실패: ${e.message}`); fail = true; } }
process.exit(fail ? 1 : 0);
