// EMN Outreach OS — PM2 alternative to systemd. Use ONE of the two, not both.
//   pm2 start deployment/pm2/ecosystem.config.cjs && pm2 save && pm2 startup
const base = '/opt/emn/current';
const env = { NODE_ENV: 'production', EMN_ENV_FILE: '/opt/emn/shared/.env' };
module.exports = {
  apps: [
    { name: 'emn-api', cwd: base, script: 'dist/backend/src/main.js', env: { ...env, EMN_SERVICE: 'emn-api' },
      instances: 1, exec_mode: 'fork', max_memory_restart: '700M', kill_timeout: 30000,
      out_file: '/var/log/emn/api.log', error_file: '/var/log/emn/api.log', merge_logs: true },
    { name: 'emn-worker', cwd: base, script: 'dist/worker/src/main.js', env: { ...env, EMN_SERVICE: 'emn-worker' },
      instances: 1, exec_mode: 'fork', max_memory_restart: '900M', kill_timeout: 90000,
      out_file: '/var/log/emn/worker.log', error_file: '/var/log/emn/worker.log', merge_logs: true },
    { name: 'emn-web', cwd: `${base}/frontend`, script: 'node_modules/next/dist/bin/next', args: 'start -H 127.0.0.1 -p 3000',
      env: { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' }, instances: 1, exec_mode: 'fork',
      out_file: '/var/log/emn/web.log', error_file: '/var/log/emn/web.log', merge_logs: true },
  ],
};
