// 14/10/2026: sqlite3@6.0.1 prebuild (linux-x64, Node 24) được build trên glibc 2.38 —
// image runtime Render chỉ có glibc cũ hơn → boot crash "GLIBC_2.38 not found"
// → deploy update_failed (prod treo trên instance cũ). Fix: trên Linux (Render) ép
// compile sqlite3 từ source để binary khớp glibc của image, rồi verify binary load được.
// Windows/macOS local: bỏ qua — dùng prebuild như cũ.
if (process.platform !== 'linux') {
  console.log('[rebuild-sqlite3] bo qua tren ' + process.platform + ' (dung prebuild)');
  process.exit(0);
}
try { require.resolve('sqlite3'); }
catch (e) { console.log('[rebuild-sqlite3] sqlite3 chua cai, bo qua'); process.exit(0); }

const { execSync } = require('child_process');
console.log('[rebuild-sqlite3] compile sqlite3 tu source (khop glibc cua image)...');
try {
  execSync('npm rebuild sqlite3 --build-from-source=true', {
    stdio: 'inherit',
    env: Object.assign({}, process.env, { npm_config_build_from_source: 'true' })
  });
} catch (e) {
  console.error('[rebuild-sqlite3] rebuild FAIL:', e.message);
  process.exit(1);
}

// Xác minh binary mới thực sự load được — chặn lỗi GLIBC lọt qua tới lúc boot
try {
  execSync('node -e ' + JSON.stringify("require('sqlite3').verbose(); console.log('[rebuild-sqlite3] binary load OK')"), { stdio: 'inherit' });
} catch (e) {
  console.error('[rebuild-sqlite3] binary van khong load duoc sau rebuild:', e.message);
  process.exit(1);
}
console.log('[rebuild-sqlite3] DONE');
